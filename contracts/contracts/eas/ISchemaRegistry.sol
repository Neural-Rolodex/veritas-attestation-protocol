// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ISchemaRegistry
/// @notice The EAS global schema registry interface (subset used by the registry).
/// @dev The real `register` accepts an ISchemaResolver, which encodes as an
///      address at the ABI level; declaring `address` keeps selectors identical.
interface ISchemaRegistry {
    /// @notice Registers a new schema and returns its UID.
    /// @param schema The schema definition.
    /// @param resolver An optional schema resolver.
    /// @param revocable Whether the schema allows revocations explicitly.
    /// @return uid The UID of the new schema.
    function register(string calldata schema, address resolver, bool revocable) external returns (bytes32 uid);
}
