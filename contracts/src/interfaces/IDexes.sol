// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Flashloan providers the executor can borrow from. Each is a
/// distinct callback protocol, so the executor implements all three.
interface IBalancerVault {
    function flashLoan(
        address recipient,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata userData
    ) external;
}

interface IAavePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IMorpho {
    /// @dev Verified against the deployed bytecode: the 3-argument selector
    /// 0xe0232b42 appears in Morpho's runtime code, the 4-argument form does
    /// not.
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

/// @notice Uniswap V3 SwapRouter (and the UniV3-compatible slice of it).
interface IUniV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
}

/// @notice Aerodrome Slipstream router. Structurally identical to V3 except the
/// pool selector is `int24 tickSpacing` rather than `uint24 fee`.
interface ISlipstreamRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
}

interface IUniV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// @notice Aerodrome v2 (Solidly-style) router: a route carries the factory and
/// a stable/volatile flag instead of an explicit path of pool addresses.
interface IAerodromeRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}
