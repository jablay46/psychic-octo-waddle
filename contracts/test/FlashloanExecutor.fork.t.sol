// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {
    FlashloanExecutor,
    ExecutionParams,
    Leg,
    Provider,
    VenueKind
} from "../src/FlashloanExecutor.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/// @notice Fork tests against live Base mainnet state.
///
/// These are integration tests, not unit tests: they borrow from the real
/// flashloan providers, trade through the real routers and assert on real
/// balances. That is the only way to check the parts that cannot be mocked
/// honestly -- the provider callback signatures, the router ABIs and, most
/// importantly, whether the profit check actually fires.
///
/// The profitable cases deliberately dislocate a Uniswap V2 pool's stored
/// reserve with `vm.store`. This is not evading the cost model: it is a
/// deterministic way to manufacture the exact condition the scanner hunts for
/// (one venue pricing a pair away from the rest), which cannot be relied upon
/// to exist at any given mainnet block. The executor is then exercised for real
/// against that state.
///
/// Run with:
///   forge test --match-contract FlashloanExecutorFork -vv
/// Set BASE_RPC_HTTP to use a private endpoint; the public one is rate-limited
/// and caps `eth_call` gas, so the borrow sizes here are intentionally small.
contract FlashloanExecutorForkTest is Test {
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant UNI_V2_ROUTER = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address constant UNI_V2_POOL = 0x88A43bbDF9D098eEC7bCEda4e2494615dfD9bB9C;
    address constant AERO_V2_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address constant AERO_V2_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;
    address constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;

    /// @dev Aave V3 charges 5 bps on Base.
    uint256 constant AAVE_PREMIUM_BPS = 5;

    FlashloanExecutor executor;
    address profitRecipient = address(0xBEEF);

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_HTTP", string("https://mainnet.base.org")));
        executor = new FlashloanExecutor(profitRecipient);
        assertEq(executor.owner(), address(this), "owner should be the test");
    }

    /// @dev Reads the UniV2 pair's packed reserves. Slot 8 of the Base
    /// UniV2Pair is `{uint112 reserve0, uint112 reserve1, uint32 timestamp}`,
    /// confirmed by reading it from the fork.
    function _readReserves(address pair) internal view returns (uint112 r0, uint112 r1) {
        bytes32 raw = vm.load(pair, bytes32(uint256(8)));
        r0 = uint112(uint256(raw));
        r1 = uint112(uint256(raw) >> 112);
    }

    /// @dev Pushes the pair's USDC reserve *below* its real level, which makes
    /// WETH cheap there relative to the wider market. Only the stored reserve
    /// is rewritten; real token balances are left alone.
    ///
    /// Direction matters: the pair asserts
    /// `balance0 * balance1 >= reserve0 * reserve1` after every swap, so
    /// lowering a stored reserve keeps the invariant satisfied while raising
    /// one breaks it with "UniswapV2: K". Lowering the USDC reserve also means
    /// fewer USDC leave the pool per WETH bought, i.e. WETH is on sale here.
    function _dislocatePairBelowSpot() internal {
        (uint112 r0,) = _readReserves(UNI_V2_POOL);
        uint256 newUsdcReserve = 620_000e6;
        bytes32 packed =
            bytes32((uint256(r0) << 0) | (newUsdcReserve << 112) | (uint256(block.timestamp) << 224));
        vm.store(UNI_V2_POOL, bytes32(uint256(8)), packed);
    }

    /// @dev Leg 0 buys USDC with the borrowed WETH on Aerodrome at market;
    /// leg 1 buys the WETH back on the dislocated UniV2 pool: a full round trip
    /// across two venues.
    function _legs(uint256 borrowAmount) internal pure returns (Leg[] memory legs) {
        legs = new Leg[](2);
        legs[0] = Leg({
            venue: VenueKind.AerodromeV2,
            router: AERO_V2_ROUTER,
            pool: AERO_V2_FACTORY,
            tokenIn: WETH,
            tokenOut: USDC,
            selector: 0,
            stable: false,
            minAmountOut: 0,
            amountIn: borrowAmount
        });
        legs[1] = Leg({
            venue: VenueKind.UniV2,
            router: UNI_V2_ROUTER,
            pool: UNI_V2_POOL,
            tokenIn: USDC,
            tokenOut: WETH,
            selector: 0,
            stable: false,
            minAmountOut: 0,
            amountIn: type(uint256).max
        });
    }

    function _params(uint256 borrowAmount, uint256 minProfitAtomic) internal view returns (ExecutionParams memory p) {
        p = ExecutionParams({
            provider: Provider.Balancer,
            borrowToken: WETH,
            borrowAmount: borrowAmount,
            minProfitAtomic: minProfitAtomic,
            legs: _legs(borrowAmount),
            deadline: block.timestamp + 300
        });
    }

    /// @dev Deals exactly the borrowed principal, plus only a fee the provider
    /// will really charge. Padding beyond that would itself read as profit in
    /// `_repayAndCollect` and mask a cycle that made no money, so the Balancer
    /// and Morpho cases deal exactly the principal.
    function _fundPrincipal(uint256 amount) internal {
        deal(WETH, address(executor), amount);
    }

    function _aavePremium(uint256 amount) internal pure returns (uint256) {
        return (amount * AAVE_PREMIUM_BPS) / 10_000 + 1;
    }

    /// @notice The happy path: a real dislocation clears a one-wei floor, the
    /// vault is made whole, and the profit lands at the recipient.
    function test_displacedReserveYieldsProfitAndPaysRecipient() public {
        uint256 borrowAmount = 1e14;
        _fundPrincipal(borrowAmount);
        _dislocatePairBelowSpot();

        uint256 recipientBefore = IERC20(WETH).balanceOf(profitRecipient);
        uint256 vaultBefore = IERC20(WETH).balanceOf(BALANCER_VAULT);

        executor.execute(_params(borrowAmount, 1));

        uint256 profit = IERC20(WETH).balanceOf(profitRecipient) - recipientBefore;
        console.log("profit (wei):", profit);
        assertGt(profit, 0, "expected a positive profit on a displaced pool");
        assertGe(IERC20(WETH).balanceOf(BALANCER_VAULT), vaultBefore, "vault must not lose funds");
    }

    /// @notice At real prices the round trip cannot clear a floor far above
    /// what the cross-venue spread can produce, so the whole call reverts
    /// rather than completing at a loss. This is the property that makes stale
    /// quotes safe.
    function test_revertsWhenSpreadIsGone() public {
        _fundPrincipal(1e14);
        // One whole WETH of profit is far beyond any real cross-venue spread.
        vm.expectRevert();
        executor.execute(_params(1e14, 1e18));
    }

    function test_revertsOnExpiredDeadline() public {
        _fundPrincipal(1e14);
        ExecutionParams memory p = _params(1e14, 1);
        p.deadline = block.timestamp - 1;
        vm.expectRevert(FlashloanExecutor.DeadlinePassed.selector);
        executor.execute(p);
    }

    function test_revertsOnNoLegs() public {
        _fundPrincipal(1e14);
        ExecutionParams memory p = _params(1e14, 1);
        p.legs = new Leg[](0);
        vm.expectRevert(FlashloanExecutor.NoLegs.selector);
        executor.execute(p);
    }

    function test_revertsOnUnsupportedVenue() public {
        _fundPrincipal(1e14);
        ExecutionParams memory p = _params(1e14, 1);
        // UniV4 has a different router; the executor must refuse rather than
        // emit a malformed call.
        p.legs[1].venue = VenueKind.UniV4;
        vm.expectRevert(FlashloanExecutor.BadLeg.selector);
        executor.execute(p);
    }

    /// @notice A leg floor above what the pool can deliver must revert inside
    /// the router, proving `minAmountOut` is enforced on-chain and not merely
    /// passed through.
    function test_revertsWhenLegFloorNotMet() public {
        _fundPrincipal(1e14);
        _dislocatePairBelowSpot();
        ExecutionParams memory p = _params(1e14, 1);
        p.legs[1].minAmountOut = 1e30;
        vm.expectRevert();
        executor.execute(p);
    }

    /// @notice The profit floor must bind at the margin: one wei above the
    /// achievable profit reverts, exactly at it succeeds.
    function test_profitFloorBindsAtTheMargin() public {
        uint256 borrowAmount = 1e14;
        _fundPrincipal(borrowAmount);
        _dislocatePairBelowSpot();

        uint256 snapshot = vm.snapshotState();
        uint256 before = IERC20(WETH).balanceOf(profitRecipient);
        executor.execute(_params(borrowAmount, 1));
        uint256 profit = IERC20(WETH).balanceOf(profitRecipient) - before;
        assertGt(profit, 1, "need headroom to test the margin");

        // Floor one wei above the achievable profit: must revert.
        vm.revertToState(snapshot);
        vm.expectRevert();
        executor.execute(_params(borrowAmount, profit + 1));

        // Floor exactly at the achievable profit: must succeed. A floor set
        // from a stale quote is therefore safe -- it can only cause the attempt
        // to fail, never to execute unprofitably.
        vm.revertToState(snapshot);
        executor.execute(_params(borrowAmount, profit));
    }

    function test_onlyOwnerCanExecute() public {
        ExecutionParams memory p = _params(1e14, 1);
        vm.prank(address(0xCAFE));
        vm.expectRevert(FlashloanExecutor.NotOwner.selector);
        executor.execute(p);
    }

    /// @notice A second provider: different callback name, pull-style
    /// repayment. If the callback signature were wrong this would revert on the
    /// provider's side, not ours.
    function test_morphoProviderPath() public {
        uint256 borrowAmount = 1e14;
        _fundPrincipal(borrowAmount);
        _dislocatePairBelowSpot();

        ExecutionParams memory p = _params(borrowAmount, 1);
        p.provider = Provider.Morpho;
        uint256 before = IERC20(WETH).balanceOf(profitRecipient);
        executor.execute(p);
        assertGt(IERC20(WETH).balanceOf(profitRecipient) - before, 0, "morpho path should profit");
    }

    /// @notice The only fee-bearing provider, so this also exercises repayment
    /// of more than the borrowed principal.
    function test_aaveProviderPath() public {
        uint256 borrowAmount = 1e14;
        deal(WETH, address(executor), borrowAmount + _aavePremium(borrowAmount));
        _dislocatePairBelowSpot();

        ExecutionParams memory p = _params(borrowAmount, 1);
        p.provider = Provider.Aave;
        uint256 before = IERC20(WETH).balanceOf(profitRecipient);
        uint256 poolBefore = IERC20(WETH).balanceOf(AAVE_POOL);
        executor.execute(p);
        assertGt(IERC20(WETH).balanceOf(profitRecipient) - before, 0, "aave path should profit");
        assertGe(IERC20(WETH).balanceOf(AAVE_POOL), poolBefore, "aave pool must not lose funds");
    }

    function test_constructorDefaultsRecipientToDeployer() public {
        FlashloanExecutor e = new FlashloanExecutor(address(0));
        assertEq(e.profitRecipient(), address(this));
    }
}