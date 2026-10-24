// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A struct representing the arguments of the attestation request.
/// @dev Mirrors the public EAS (v1) interface. ISchemaResolver params in the
///      real interface are encoded as addresses at the ABI level, so declaring
///      them as `address` keeps selectors identical.
struct AttestationRequestData {
    address recipient; // The recipient of the attestation.
    uint64 expirationTime; // The time when the attestation expires (Unix timestamp).
    bool revocable; // Whether the attestation is revocable.
    bytes32 refUID; // The UID of the related attestation.
    bytes data; // Custom attestation data.
    uint256 value; // An explicit ETH amount to send to the resolver.
}

/// @notice A struct representing the full arguments of the attestation request.
struct AttestationRequest {
    bytes32 schema; // The unique identifier of the schema.
    AttestationRequestData data; // The arguments of the attestation request.
}

/// @notice A struct representing the arguments of the revocation request.
struct RevocationRequestData {
    bytes32 uid; // The UID of the attestation to revoke.
    uint256 value; // An explicit ETH amount to send to the resolver.
}

/// @notice A struct representing the full arguments of the revocation request.
struct RevocationRequest {
    bytes32 schema; // The unique identifier of the schema.
    RevocationRequestData data; // The arguments of the revocation request.
}

/// @notice A struct representing an on-chain attestation.
struct Attestation {
    bytes32 uid; // A unique identifier of the attestation.
    bytes32 schema; // The unique identifier of the schema.
    uint64 time; // The time when the attestation was created (Unix timestamp).
    uint64 expirationTime; // The time when the attestation expires (Unix timestamp).
    uint64 revocationTime; // The time when the attestation was revoked (Unix timestamp).
    bytes32 refUID; // The UID of the related attestation.
    address recipient; // The recipient of the attestation.
    address attester; // The attester/sender of the attestation.
    bool revocable; // Whether the attestation is revocable.
    bytes data; // Custom attestation data.
}

/// @title IEAS
/// @notice The Ethereum Attestation Service interface (subset used by the registry).
interface IEAS {
    /// @notice Attests to a schema, via an EIP712 signature.
    /// @param request The full arguments of the attestation request.
    /// @return The UID of the new attestation.
    function attest(AttestationRequest calldata request) external payable returns (bytes32);

    /// @notice Revokes an existing attestation to a schema.
    /// @param request The full arguments of the revocation request.
    function revoke(RevocationRequest calldata request) external payable;

    /// @notice Retrieves an attestation by its identifier.
    /// @param uid The UID of the attestation.
    /// @return The attestation matching the provided UID.
    function getAttestation(bytes32 uid) external view returns (Attestation memory);
}
