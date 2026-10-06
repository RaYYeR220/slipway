// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title ForecastAnchor
/// @notice Append-only commitments to Slipway's pre-registered execution-cost forecasts.
/// Each anchor is a Merkle root over the ledger entries registered in the window [fromTs, toTs).
/// Windows are contiguous and closed in the past, so no forecast can be inserted after its outcome is known
/// and no window can be skipped or rewritten.
contract ForecastAnchor {
    struct Anchor {
        bytes32 root;
        uint64 count;
        uint64 fromTs;
        uint64 toTs;
        uint64 anchoredAt;
    }

    /// @notice The only address allowed to append anchors.
    address public immutable anchorer;
    /// @notice Hash of the evaluation protocol (universe, sizes, seed, grading rules) fixed at deployment.
    bytes32 public immutable protocolHash;
    /// @notice Start of the first window; every later window starts where the previous one ended.
    uint64 public immutable genesisTs;

    Anchor[] private _anchors;

    event Anchored(uint256 indexed index, bytes32 indexed root, uint64 count, uint64 fromTs, uint64 toTs);

    error NotAnchorer();
    error EmptyBatch();
    error NonContiguousWindow(uint64 expectedFrom, uint64 gotFrom);
    error InvalidWindow();
    error WindowNotClosed();
    error UnknownAnchor();

    constructor(address anchorer_, bytes32 protocolHash_, uint64 genesisTs_) {
        anchorer = anchorer_;
        protocolHash = protocolHash_;
        genesisTs = genesisTs_;
    }

    function anchor(bytes32 root, uint64 count, uint64 fromTs, uint64 toTs) external returns (uint256 index) {
        if (msg.sender != anchorer) revert NotAnchorer();
        if (root == bytes32(0) || count == 0) revert EmptyBatch();
        if (toTs <= fromTs) revert InvalidWindow();
        if (toTs > block.timestamp) revert WindowNotClosed();

        index = _anchors.length;
        uint64 expectedFrom = index == 0 ? genesisTs : _anchors[index - 1].toTs;
        if (fromTs != expectedFrom) revert NonContiguousWindow(expectedFrom, fromTs);

        _anchors.push(Anchor(root, count, fromTs, toTs, uint64(block.timestamp)));
        emit Anchored(index, root, count, fromTs, toTs);
    }

    function anchorCount() external view returns (uint256) {
        return _anchors.length;
    }

    function getAnchor(uint256 index) external view returns (Anchor memory) {
        if (index >= _anchors.length) revert UnknownAnchor();
        return _anchors[index];
    }

    /// @notice Inclusion check for a ledger entry. Leaves are keccak256(entryHash); pairs are hashed in sorted order.
    function verify(uint256 index, bytes32 entryHash, bytes32[] calldata proof) external view returns (bool) {
        if (index >= _anchors.length) revert UnknownAnchor();
        bytes32 node = keccak256(abi.encodePacked(entryHash));
        for (uint256 i = 0; i < proof.length; ++i) {
            bytes32 p = proof[i];
            node = node < p ? keccak256(abi.encodePacked(node, p)) : keccak256(abi.encodePacked(p, node));
        }
        return node == _anchors[index].root;
    }
}
