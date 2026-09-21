// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";
import {
    IBalancerVault,
    IAavePool,
    IMorpho,
    IUniV3Router,
    ISlipstreamRouter,
    IUniV2Router,
    IAerodromeRouter
} from "./interfaces/IDexes.sol";

/// @title FlashloanExecutor
/// @notice Executes a two-venue DEX-DEX arbitrage cycle inside a single
/// flashloan, atomically.
///
/// Design notes worth stating explicitly, because each is a deliberate
/// trade-off rather than an omission:
///
/// 1. It is a dumb executor. Sizing, leg selection and profitability are
///    computed off-chain by the TypeScript scanner (Phase 3), and the exact
///    legs are passed in. Re-deriving them on-chain would mean reproducing the
///    cost model in Solidity and paying for it in gas on every attempt.
///
/// 2. It reverts on any unprofitable outcome. The caller passes
///    `minProfitAtomic`, computed off-chain as the net profit floor; if the
///    swaps do not clear it the transaction reverts and the only cost is gas.
///    This is what makes stale quotes safe: a leg that moved between quoting
///    and inclusion simply fails rather than losing money.
///
/// 3. The profit floor is expressed in the borrowed token, not USD. The
///    contract cannot see a price feed, so it cannot know what the token is
///    worth; committing to an atomic-unit floor is the only honest option.
///
/// 4. Profit goes to the owner, and repayment is verified by balance rather
///    than assumed. `_repay` reads the provider's balance before and after,
///    so a provider that changes its accounting cannot leave the contract
///    owing.

/// @dev Which flashloan provider to borrow from. Ordered by preference within
/// the off-chain scanner, not here.
enum Provider {
    Balancer,
    Morpho,
    Aave
}

/// @dev Which venue AMM family a leg trades on. Each needs a different
/// router call, and for the CL venues a different pool selector.
enum VenueKind {
    UniV3,
    UniV2,
    AerodromeV2,
    Slipstream,
    UniV4
}

struct Leg {
    VenueKind venue;
    address router;
    address pool;
    address tokenIn;
    address tokenOut;
    /// @dev CL venues only: UniV3 fee in hundredths of a bip, or the
    /// Slipstream tick spacing. Ignored by the constant-product venues.
    uint24 selector;
    /// @dev Aerodrome v2 only. Ignored elsewhere.
    bool stable;
    /// @dev Floor for this leg's output, in `tokenOut` atomic units, supplied
    /// by the off-chain scanner from its own simulation. The contract cannot
    /// derive it: it has no price feed and no knowledge of the pool's curve.
    uint256 minAmountOut;
    /// @dev Amount of `tokenIn` to swap. Pass `type(uint256).max` to consume
    /// the contract's whole balance, which is what a leg chained onto the
    /// output of the previous one wants.
    uint256 amountIn;
}

struct ExecutionParams {
    Provider provider;
    address borrowToken;
    uint256 borrowAmount;
    /// @dev Net profit floor in borrowed-token atomic units. See note 3.
    uint256 minProfitAtomic;
    /// @dev All legs before repayment, in order. The last leg must return the
    /// borrowed token so repayment can be verified by balance.
    Leg[] legs;
    /// @dev Timestamp after which every leg reverts. Bounds how stale a quote
    /// can be when the transaction lands.
    uint256 deadline;
}

contract FlashloanExecutor {
    /// @dev Balancer V2 vault on Base. Holds the deepest WETH cushion.
    IBalancerVault public constant BALANCER_VAULT =
        IBalancerVault(0xBA12222222228d8Ba445958a75a0704d566BF2C8);
    /// @dev Morpho on Base. Zero-fee flashloans, WETH-heavy.
    IMorpho public constant MORPHO = IMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    /// @dev Aave V3 pool on Base. Charges the configured premium.
    IAavePool public constant AAVE_POOL = IAavePool(0xA238Dd80C259a72e81d7e4664a9801593F98d1c5);

    address public immutable owner;
    /// @dev Recipient of realised profit; fixed at deploy time so a
    /// compromised caller cannot redirect funds.
    address public immutable profitRecipient;

    /// @dev Reentrancy lock. The provider callbacks re-enter this contract, so
    /// without a lock a malicious router could invoke `execute` mid-flight.
    uint256 private _locked = 1;

    /// @dev Transient storage holds the decoded params for the duration of the
    /// flashloan callback, avoiding a round trip through calldata encoding.
    ExecutionParams private _params;
    /// @dev Set inside the callback so the outer call can confirm it ran.
    bool private _callbackRan;
    /// @dev True only between handing control to the provider and regaining it.
    /// The callbacks check it so a loan this contract did not initiate -- a
    /// third party can name any address as a flashloan receiver -- cannot drive
    /// the stored legs. See `_runLegs`.
    bool private _inFlight;
    /// @dev Provider's balance of the borrowed token measured just before the
    /// swaps, so repayment can be verified against what was actually owed.
    uint256 private _amountOwed;

    error NotOwner();
    error NotProvider();
    error Locked();
    error DeadlinePassed();
    error CallbackNotRun();
    error Unprofitable(uint256 balanceAfterRepay, uint256 requiredBalance);
    error LegFailed(uint256 index, bytes reason);
    error NoLegs();
    error BadLeg();
    error TransferFailed();
    error ApproveFailed();
    error ZeroAddress();

    event Executed(
        Provider indexed provider,
        address indexed borrowToken,
        uint256 borrowAmount,
        uint256 profit,
        address recipient
    );

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Locked();
        _locked = 2;
        _;
        _locked = 1;
    }

    /// @dev A zero `profitRecipient_` is not an error: it means "send profit to
    /// the deployer", which the tests and the deploy script both rely on. The
    /// value is fixed here and can never be changed, so a compromised owner
    /// cannot redirect realised profit.
    // forge-lint: disable-next-line(missing-zero-check)
    constructor(address profitRecipient_) {
        owner = msg.sender;
        profitRecipient = profitRecipient_ == address(0) ? msg.sender : profitRecipient_;
    }

    /// @notice Borrows, runs the legs, repays and forwards any profit.
    /// @dev Reverts unless the cycle clears `minProfitAtomic`. See note 2.
    function execute(ExecutionParams calldata params) external nonReentrant onlyOwner {
        if (params.deadline < block.timestamp) revert DeadlinePassed();
        if (params.legs.length == 0) revert NoLegs();

        _params = params;
        _callbackRan = false;
        _inFlight = true;

        // The provider callbacks all check the caller against the provider's
        // own address, so a stray callback cannot be spoofed -- but the decoded
        // params must only be trusted while a flashloan is in flight.
        if (params.provider == Provider.Balancer) {
            address[] memory tokens = new address[](1);
            tokens[0] = params.borrowToken;
            uint256[] memory amounts = new uint256[](1);
            amounts[0] = params.borrowAmount;
            BALANCER_VAULT.flashLoan(address(this), tokens, amounts, abi.encode(params.minProfitAtomic));
        } else if (params.provider == Provider.Morpho) {
            MORPHO.flashLoan(params.borrowToken, params.borrowAmount, abi.encode(params.minProfitAtomic));
        } else {
            AAVE_POOL.flashLoanSimple(
                address(this),
                params.borrowToken,
                params.borrowAmount,
                abi.encode(params.minProfitAtomic),
                0
            );
        }

        // Control is back, so the callback window is over whether or not it
        // fired. Clearing the flag here means a later, unrelated provider
        // callback finds `_inFlight == false` and is refused.
        _inFlight = false;
        if (!_callbackRan) revert CallbackNotRun();
    }

    /// @dev Balancer V2/V3 flashloan callback.
    function receiveFlashLoan(
        address[] calldata,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata
    ) external {
        if (msg.sender != address(BALANCER_VAULT)) revert NotProvider();
        _amountOwed = amounts[0] + feeAmounts[0];
        _runLegs();
    }

    /// @dev Morpho flashloan callback. Morpho charges no fee, but the owed
    /// amount is read from the callback argument rather than assumed to equal
    /// the borrowed amount, so a future fee cannot silently under-fund it.
    function onMorphoFlashLoan(uint256 assets, bytes calldata) external {
        if (msg.sender != address(MORPHO)) revert NotProvider();
        _amountOwed = assets;
        _runLegs();
    }

    /// @dev Aave V3 simple flashloan callback. `premium` is the fee on top of
    /// `amount`.
    function executeOperation(
        address,
        uint256 amount,
        uint256 premium,
        address,
        bytes calldata
    ) external returns (bool) {
        if (msg.sender != address(AAVE_POOL)) revert NotProvider();
        _amountOwed = amount + premium;
        _runLegs();
        return true;
    }

    /// @dev Runs every leg, then repays and checks profit in the same frame so
    /// a failure reverts the whole transaction. Keeping repayment inside the
    /// callback is what lets the check be atomic.
    ///
    /// `_inFlight` is checked first: a provider callback can only be trusted
    /// when this contract initiated the loan. Without the guard, an attacker
    /// could call Balancer/Morpho/Aave naming this contract as receiver, which
    /// would replay whatever legs are still stored from a previous run.
    function _runLegs() internal {
        if (!_inFlight) revert NotProvider();
        ExecutionParams storage p = _params;
        _callbackRan = true;

        for (uint256 i = 0; i < p.legs.length; i++) {
            _swap(p.legs[i], i);
        }

        _repayAndCollect(p.borrowToken, p.minProfitAtomic);
        // The loan is settled, so the stored legs are spent. Clearing them
        // removes the replay surface entirely rather than relying on the flag.
        delete _params;
    }

    /// @dev Dispatches one leg to the right router. `amountOutMinimum` comes
    /// from the off-chain simulation; `amountIn` is either that simulation's
    /// input or `type(uint256).max` to sweep the contract's whole balance of
    /// `tokenIn`, which is reserved for a later leg so earlier legs cannot
    /// accidentally spend the borrowed principal.
    function _swap(Leg storage leg, uint256 index) internal {
        uint256 balance = IERC20(leg.tokenIn).balanceOf(address(this));
        uint256 amountIn = leg.amountIn == type(uint256).max ? balance : leg.amountIn;
        if (amountIn == 0 || amountIn > balance) revert BadLeg();
        // A tick spacing wider than int24 would truncate into a different,
        // valid-looking pool. Real spacing is a few hundred at most.
        if (leg.venue == VenueKind.Slipstream && leg.selector > 8_388_607) revert BadLeg();

        if (leg.venue == VenueKind.UniV3) {
            _approve(leg.tokenIn, leg.router, amountIn);
            IUniV3Router.ExactInputSingleParams memory q = IUniV3Router.ExactInputSingleParams({
                tokenIn: leg.tokenIn,
                tokenOut: leg.tokenOut,
                fee: leg.selector,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: leg.minAmountOut,
                sqrtPriceLimitX96: 0
            });
            _call(leg.router, abi.encodeWithSelector(IUniV3Router.exactInputSingle.selector, q), index);
        } else if (leg.venue == VenueKind.Slipstream) {
            _approve(leg.tokenIn, leg.router, amountIn);
            ISlipstreamRouter.ExactInputSingleParams memory q = ISlipstreamRouter.ExactInputSingleParams({
                tokenIn: leg.tokenIn,
                tokenOut: leg.tokenOut,
                // Bounded by the BadLeg check above, so this cannot truncate.
                tickSpacing: int24(uint24(leg.selector)), // forge-lint: disable-next-line(unsafe-typecast)
                recipient: address(this),
                deadline: _params.deadline,
                amountIn: amountIn,
                amountOutMinimum: leg.minAmountOut,
                sqrtPriceLimitX96: 0
            });
            _call(leg.router, abi.encodeWithSelector(ISlipstreamRouter.exactInputSingle.selector, q), index);
        } else if (leg.venue == VenueKind.UniV2) {
            _approve(leg.tokenIn, leg.router, amountIn);
            address[] memory path = new address[](2);
            path[0] = leg.tokenIn;
            path[1] = leg.tokenOut;
            _call(
                leg.router,
                abi.encodeWithSelector(
                    IUniV2Router.swapExactTokensForTokens.selector,
                    amountIn,
                    leg.minAmountOut,
                    path,
                    address(this),
                    _params.deadline
                ),
                index
            );
        } else if (leg.venue == VenueKind.AerodromeV2) {
            _approve(leg.tokenIn, leg.router, amountIn);
            IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
            routes[0] = IAerodromeRouter.Route({
                from: leg.tokenIn,
                to: leg.tokenOut,
                stable: leg.stable,
                factory: leg.pool
            });
            _call(
                leg.router,
                abi.encodeWithSelector(
                    IAerodromeRouter.swapExactTokensForTokens.selector,
                    amountIn,
                    leg.minAmountOut,
                    routes,
                    address(this),
                    _params.deadline
                ),
                index
            );
        } else {
            // UniV4 pools live in a singleton and need a different router
            // entirely; refusing here is better than sending a malformed call.
            revert BadLeg();
        }
    }

    /// @dev Bubbles the router's revert reason with the leg index, so a failed
    /// attempt is diagnosable from the receipt alone.
    function _call(address target, bytes memory data, uint256 index) internal {
        (bool ok, bytes memory reason) = target.call(data);
        if (!ok) revert LegFailed(index, reason);
    }

    /// @dev Repays the provider and forwards the residual.
    ///
    /// The repayment mechanism differs per provider and this is the one place
    /// it is safe to branch on:
    ///   * Balancer V2 measures its own balance before and after the callback
    ///     and reverts with BAL#515 unless it is restored, so the contract must
    ///     send the owed amount back explicitly.
    ///   * Morpho and Aave both pull the owed amount with `transferFrom` after
    ///     the callback returns, so an exact approval is required instead.
    /// Sending owed *and* approving would double-pay on the pull providers;
    /// approving a balance-delta provider would repay nothing at all.
    ///
    /// `minProfitAtomic` is checked here, inside the callback, so a cycle that
    /// does not clear it reverts the whole transaction rather than completing
    /// at a loss. See note 2 at the top of the file.
    function _repayAndCollect(address token, uint256 minProfitAtomic) internal {
        uint256 owed = _amountOwed;
        uint256 balance = IERC20(token).balanceOf(address(this));

        if (balance < owed + minProfitAtomic) {
            revert Unprofitable(balance, owed + minProfitAtomic);
        }

        uint256 profit = balance - owed;
        // All three tokens on the watchlist return a bool and no provider is a
        // fee-on-transfer token, so a false return must be treated as failure
        // rather than ignored.
        if (_params.provider == Provider.Balancer) {
            _transfer(token, address(BALANCER_VAULT), owed);
        } else {
            _approve(token, _providerAddress(), owed);
        }
        if (profit > 0) {
            _transfer(token, profitRecipient, profit);
        }
        emit Executed(_params.provider, token, _params.borrowAmount, profit, profitRecipient);
    }

    function _providerAddress() internal view returns (address) {
        Provider provider = _params.provider;
        if (provider == Provider.Balancer) return address(BALANCER_VAULT);
        if (provider == Provider.Morpho) return address(MORPHO);
        return address(AAVE_POOL);
    }

    /// @notice Rescues tokens sent here by mistake. Only the owner, and only
    /// tokens this contract does not need mid-flight, which the lock enforces.
    function sweep(address token, uint256 amount) external nonReentrant onlyOwner {
        _transfer(token, owner, amount);
    }

    /// @dev ERC20 transfers can return false instead of reverting; checking the
    /// return value is the only way to notice a silent failure.
    function _transfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _approve(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(
            abi.encodeWithSelector(IERC20.approve.selector, spender, amount)
        );
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert ApproveFailed();
    }
}
