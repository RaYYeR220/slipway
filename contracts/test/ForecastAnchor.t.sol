// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ForecastAnchor} from "../src/ForecastAnchor.sol";

interface Vm {
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert(bytes calldata) external;
    function expectRevert(bytes4) external;
    function expectEmit(bool, bool, bool, bool) external;
    function assume(bool) external;
}

contract ForecastAnchorTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    ForecastAnchor anchorC;
    address constant ANCHORER = address(0xA11CE);
    bytes32 constant PROTOCOL = keccak256("slipway-eval-v1");
    uint64 constant GENESIS = 1_791_200_000;

    event Anchored(uint256 indexed index, bytes32 indexed root, uint64 count, uint64 fromTs, uint64 toTs);

    function setUp() public {
        anchorC = new ForecastAnchor(ANCHORER, PROTOCOL, GENESIS);
        vm.warp(GENESIS + 10_000);
    }

    function _leaf(bytes32 h) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(h));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function test_immutables() public view {
        require(anchorC.anchorer() == ANCHORER, "anchorer");
        require(anchorC.protocolHash() == PROTOCOL, "protocol");
        require(anchorC.genesisTs() == GENESIS, "genesis");
    }

    function test_firstAnchorStartsAtGenesis() public {
        vm.prank(ANCHORER);
        uint256 i = anchorC.anchor(bytes32(uint256(1)), 3, GENESIS, GENESIS + 1800);
        require(i == 0 && anchorC.anchorCount() == 1, "index");
        ForecastAnchor.Anchor memory a = anchorC.getAnchor(0);
        require(a.count == 3 && a.fromTs == GENESIS && a.toTs == GENESIS + 1800, "fields");
        require(a.anchoredAt == GENESIS + 10_000, "anchoredAt");
    }

    function test_emitsAnchored() public {
        vm.expectEmit(true, true, false, true);
        emit Anchored(0, bytes32(uint256(7)), 2, GENESIS, GENESIS + 60);
        vm.prank(ANCHORER);
        anchorC.anchor(bytes32(uint256(7)), 2, GENESIS, GENESIS + 60);
    }

    function test_windowsMustBeContiguous() public {
        vm.prank(ANCHORER);
        anchorC.anchor(bytes32(uint256(1)), 1, GENESIS, GENESIS + 100);
        vm.expectRevert(abi.encodeWithSelector(ForecastAnchor.NonContiguousWindow.selector, GENESIS + 100, GENESIS + 101));
        vm.prank(ANCHORER);
        anchorC.anchor(bytes32(uint256(2)), 1, GENESIS + 101, GENESIS + 200);
    }

    function test_cannotRewriteAWindow() public {
        vm.prank(ANCHORER);
        anchorC.anchor(bytes32(uint256(1)), 1, GENESIS, GENESIS + 100);
        vm.expectRevert(abi.encodeWithSelector(ForecastAnchor.NonContiguousWindow.selector, GENESIS + 100, GENESIS));
        vm.prank(ANCHORER);
        anchorC.anchor(bytes32(uint256(9)), 1, GENESIS, GENESIS + 100);
    }

    function test_firstWindowMustStartAtGenesis() public {
        vm.expectRevert(abi.encodeWithSelector(ForecastAnchor.NonContiguousWindow.selector, GENESIS, GENESIS + 1));
        vm.prank(ANCHORER);
        anchorC.anchor(bytes32(uint256(1)), 1, GENESIS + 1, GENESIS + 100);
    }

    function test_onlyAnchorer() public {
        vm.expectRevert(ForecastAnchor.NotAnchorer.selector);
        anchorC.anchor(bytes32(uint256(1)), 1, GENESIS, GENESIS + 100);
    }

    function test_rejectsOpenWindow() public {
        vm.expectRevert(ForecastAnchor.WindowNotClosed.selector);
        vm.prank(ANCHORER);
        anchorC.anchor(bytes32(uint256(1)), 1, GENESIS, GENESIS + 10_001);
    }

    function test_rejectsEmptyBatch() public {
        vm.expectRevert(ForecastAnchor.EmptyBatch.selector);
        vm.prank(ANCHORER);
        anchorC.anchor(bytes32(0), 1, GENESIS, GENESIS + 100);
        vm.expectRevert(ForecastAnchor.EmptyBatch.selector);
        vm.prank(ANCHORER);
        anchorC.anchor(bytes32(uint256(1)), 0, GENESIS, GENESIS + 100);
    }

    function test_rejectsInvertedWindow() public {
        vm.expectRevert(ForecastAnchor.InvalidWindow.selector);
        vm.prank(ANCHORER);
        anchorC.anchor(bytes32(uint256(1)), 1, GENESIS, GENESIS);
    }

    function test_verifyInclusion() public {
        bytes32 e0 = keccak256("entry-0");
        bytes32 e1 = keccak256("entry-1");
        bytes32 e2 = keccak256("entry-2");
        bytes32 l0 = _leaf(e0);
        bytes32 l1 = _leaf(e1);
        bytes32 l2 = _leaf(e2);
        bytes32 n01 = _pair(l0, l1);
        bytes32 root = _pair(n01, l2);
        vm.prank(ANCHORER);
        anchorC.anchor(root, 3, GENESIS, GENESIS + 100);

        bytes32[] memory p0 = new bytes32[](2);
        p0[0] = l1;
        p0[1] = l2;
        require(anchorC.verify(0, e0, p0), "e0");

        bytes32[] memory p2 = new bytes32[](1);
        p2[0] = n01;
        require(anchorC.verify(0, e2, p2), "e2");

        // negative control: an entry that was never registered must not verify
        require(!anchorC.verify(0, keccak256("entry-forged"), p0), "forged");
    }

    function test_unknownAnchorReverts() public {
        vm.expectRevert(ForecastAnchor.UnknownAnchor.selector);
        anchorC.getAnchor(0);
    }

    function testFuzz_chainOfWindows(uint8 n, uint32 step) public {
        vm.assume(n > 0 && n < 40 && step > 0 && uint256(step) * n < 10_000);
        uint64 from = GENESIS;
        for (uint256 i = 0; i < n; ++i) {
            vm.prank(ANCHORER);
            anchorC.anchor(keccak256(abi.encode(i)), 1, from, from + step);
            from += step;
        }
        require(anchorC.anchorCount() == n, "count");
    }
}
