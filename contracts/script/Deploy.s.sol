// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ForecastAnchor} from "../src/ForecastAnchor.sol";

interface Vm {
    function envAddress(string calldata) external view returns (address);
    function envBytes32(string calldata) external view returns (bytes32);
    function envUint(string calldata) external view returns (uint256);
    function startBroadcast() external;
    function stopBroadcast() external;
}

contract Deploy {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (ForecastAnchor deployed) {
        address anchorer = vm.envAddress("ANCHORER");
        bytes32 protocolHash = vm.envBytes32("PROTOCOL_HASH");
        uint64 genesisTs = uint64(vm.envUint("GENESIS_TS"));
        vm.startBroadcast();
        deployed = new ForecastAnchor(anchorer, protocolHash, genesisTs);
        vm.stopBroadcast();
    }
}
