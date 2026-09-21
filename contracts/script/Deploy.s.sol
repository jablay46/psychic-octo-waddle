// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FlashloanExecutor} from "../src/FlashloanExecutor.sol";

/// @notice Deploys the executor.
///
///   forge script script/Deploy.s.sol --rpc-url $BASE_RPC_HTTP \
///     --private-key $PRIVATE_KEY --broadcast
///
/// PROFIT_RECIPIENT defaults to the deployer when unset, which is the sane
/// choice for a first deployment: profit should never go somewhere nobody
/// controls. Set it explicitly once a treasury multisig exists.
contract Deploy is Script {
    function run() external returns (FlashloanExecutor executor) {
        address recipient = vm.envOr("PROFIT_RECIPIENT", address(0));

        vm.startBroadcast();
        executor = new FlashloanExecutor(recipient);
        vm.stopBroadcast();

        console.log("FlashloanExecutor deployed at", address(executor));
        console.log("owner (deployer)", executor.owner());
        console.log("profitRecipient", executor.profitRecipient());
    }
}