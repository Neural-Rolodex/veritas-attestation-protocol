// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { Attestation, AttestationRequest, AttestationRequestData, IEAS, RevocationRequest, RevocationRequestData } from "./eas/IEAS.sol";
import { ISchemaRegistry } from "./eas/ISchemaRegistry.sol";

/// @title ImpactAttestationRegistry
/// @notice An on-chain registry that logs verifiable impact badges, impact
///         scores and milestone attestations (via EAS) for registered
///         open-source repositories.
///
///         The registry is the attester: the backend oracle (a privileged
///         role) registers repositories and triggers attestations, which the
///         registry mints through the Ethereum Attestation Service. Every
///         attestation UID is recorded per repository so the registry acts as
///         a queryable, verifiable log of impact.
contract ImpactAttestationRegistry is Ownable {
    /// @notice The EAS contract used to mint attestations.
    IEAS public immutable eas;

    /// @notice The EAS schema registry used to register attestation schemas.
    ISchemaRegistry public immutable schemaRegistry;

    /// @notice Schema UID for impact badges:
    ///         (string repoUrl,string badge,uint256 score,string metadataURI)
    bytes32 public immutable impactBadgeSchema;

    /// @notice Schema UID for milestones:
    ///         (string repoUrl,string milestone,uint256 value,string metadataURI)
    bytes32 public immutable milestoneSchema;

    /// @notice Schema UID for drip list attestations:
    ///         (string metadataURI)
    bytes32 public immutable dripListSchema;

    /// @notice The address allowed to register repositories and mint attestations.
    address public oracle;

    /// @notice A registered open-source repository.
    struct Repository {
        bytes32 id; // keccak256(repoUrl)
        string repoUrl;
        string name;
        string packageType;
        address owner; // recipient of attestations (0 if unset)
        string metadataURI;
        bool active;
        uint256 registeredAt;
    }

    /// @notice A record of an attestation minted by this registry for a repo.
    struct RepoAttestationRecord {
        bytes32 repoId;
        string kind; // "badge" | "milestone" | "score"
        uint256 value;
        uint256 createdAt;
    }

    /// @notice All registered repository ids, in registration order.
    bytes32[] private _repositoryIds;

    /// @notice Registered repositories keyed by id.
    mapping(bytes32 => Repository) private _repositories;

    /// @notice Per-repository attestation UIDs, in creation order.
    mapping(bytes32 => bytes32[]) private _repoAttestations;

    /// @notice UID -> attestation record for attestations minted by this registry.
    mapping(bytes32 => RepoAttestationRecord) private _attestationRecords;

    event RepositoryRegistered(bytes32 indexed repoId, string repoUrl, string name);
    event RepositoryUpdated(bytes32 indexed repoId, string repoUrl, string name, bool active);
    event ImpactAttestationCreated(bytes32 indexed repoId, bytes32 indexed uid, string attestationType, uint256 value);
    event DripListAttested(bytes32 indexed uid, address indexed attester, string metadataURI);
    event OracleChanged(address indexed oracle);

    error NotOracle();
    error RepositoryNotFound();
    error RepositoryAlreadyRegistered();
    error AttestationNotFound();
    error EmptyUid();
    error EmptyString();
    error ZeroAddress();

    modifier onlyOracle() {
        if (msg.sender != oracle) revert NotOracle();
        _;
    }

    /// @param eas_ The EAS contract address.
    /// @param schemaRegistry_ The EAS schema registry address.
    /// @param impactBadgeSchemaString Schema string for impact badges.
    /// @param milestoneSchemaString Schema string for milestones.
    /// @param dripListSchemaString Schema string for drip list attestations.
    /// @param revocable Whether the schemas (and thus attestations) are revocable.
    constructor(
        address eas_,
        address schemaRegistry_,
        string memory impactBadgeSchemaString,
        string memory milestoneSchemaString,
        string memory dripListSchemaString,
        bool revocable
    ) Ownable(msg.sender) {
        if (eas_ == address(0) || schemaRegistry_ == address(0)) {
            revert ZeroAddress();
        }

        eas = IEAS(eas_);
        schemaRegistry = ISchemaRegistry(schemaRegistry_);

        impactBadgeSchema = schemaRegistry.register(impactBadgeSchemaString, address(0), revocable);
        milestoneSchema = schemaRegistry.register(milestoneSchemaString, address(0), revocable);
        dripListSchema = schemaRegistry.register(dripListSchemaString, address(0), revocable);
    }

    /// @notice Sets the oracle role. Only owner.
    function setOracle(address oracle_) external onlyOwner {
        if (oracle_ == address(0)) revert EmptyString();
        oracle = oracle_;
        emit OracleChanged(oracle_);
    }

    /// @notice The total number of registered repositories.
    function repositoryCount() external view returns (uint256) {
        return _repositoryIds.length;
    }

    /// @notice The ids of all registered repositories.
    function repositoryIds() external view returns (bytes32[] memory) {
        return _repositoryIds;
    }

    /// @notice Looks up a repository by its id (keccak256(repoUrl)).
    function repository(bytes32 id) external view returns (Repository memory) {
        return _repositories[id];
    }

    /// @notice The attestation UIDs recorded for a repository.
    function repositoryAttestations(bytes32 repoId) external view returns (bytes32[] memory) {
        return _repoAttestations[repoId];
    }

    /// @notice The attestation record for a UID minted by this registry.
    function attestationRecord(bytes32 uid) external view returns (RepoAttestationRecord memory) {
        return _attestationRecords[uid];
    }

    /// @notice Reads an attestation directly from EAS.
    function getAttestation(bytes32 uid) external view returns (Attestation memory) {
        return eas.getAttestation(uid);
    }

    /// @notice Returns whether an attestation UID exists on EAS and is not revoked.
    function verifyAttestation(bytes32 uid) external view returns (bool) {
        Attestation memory attestation = eas.getAttestation(uid);
        return attestation.uid != 0 && attestation.revocationTime == 0;
    }

    /// @notice Registers a repository so its impact can be attested. Oracle only.
    /// @return repoId The id of the registered repository.
    function registerRepository(
        string calldata repoUrl,
        string calldata name,
        string calldata packageType,
        address owner,
        string calldata metadataURI
    ) external onlyOracle returns (bytes32 repoId) {
        if (bytes(repoUrl).length == 0 || bytes(name).length == 0) {
            revert EmptyString();
        }

        repoId = _getRepoId(repoUrl);
        if (_repositories[repoId].id != 0) {
            revert RepositoryAlreadyRegistered();
        }

        _repositories[repoId] = Repository({
            id: repoId,
            repoUrl: repoUrl,
            name: name,
            packageType: packageType,
            owner: owner,
            metadataURI: metadataURI,
            active: true,
            registeredAt: block.timestamp
        });
        _repositoryIds.push(repoId);

        emit RepositoryRegistered(repoId, repoUrl, name);
    }

    /// @notice Updates a repository's metadata. Oracle only.
    function updateRepository(
        bytes32 repoId,
        string calldata name,
        string calldata packageType,
        address owner,
        string calldata metadataURI
    ) external onlyOracle {
        _requireRepository(repoId);

        _repositories[repoId].name = name;
        _repositories[repoId].packageType = packageType;
        _repositories[repoId].owner = owner;
        _repositories[repoId].metadataURI = metadataURI;

        emit RepositoryUpdated(repoId, _repositories[repoId].repoUrl, name, _repositories[repoId].active);
    }

    /// @notice Marks a repository active/inactive. Oracle only.
    function setRepositoryActive(bytes32 repoId, bool active) external onlyOracle {
        _requireRepository(repoId);

        _repositories[repoId].active = active;

        emit RepositoryUpdated(repoId, _repositories[repoId].repoUrl, _repositories[repoId].name, active);
    }

    /// @notice Mints an impact badge attestation for a repository. Oracle only.
    /// @param repoUrl The repository URL.
    /// @param badge The badge key, e.g. "verified-impact".
    /// @param score The score backing the badge (0-10000 for precision).
    /// @param metadataURI A URI resolving to the badge metadata.
    /// @return uid The UID of the minted attestation.
    function attestImpactBadge(
        string calldata repoUrl,
        string calldata badge,
        uint256 score,
        string calldata metadataURI
    ) external onlyOracle returns (bytes32 uid) {
        if (bytes(badge).length == 0) {
            revert EmptyString();
        }

        bytes32 repoId = _getRepoId(repoUrl);
        _requireRepository(repoId);

        uid = _attest(
            impactBadgeSchema,
            _recipientFor(repoId),
            abi.encode(repoUrl, badge, score, metadataURI)
        );

        _recordAttestation(repoId, uid, "badge", score);
        emit ImpactAttestationCreated(repoId, uid, badge, score);
    }

    /// @notice Mints a milestone attestation for a repository. Oracle only.
    /// @param repoUrl The repository URL.
    /// @param milestone The milestone key, e.g. "1m-monthly-downloads".
    /// @param value The measured value that triggered the milestone.
    /// @param metadataURI A URI resolving to the milestone metadata.
    /// @return uid The UID of the minted attestation.
    function attestMilestone(
        string calldata repoUrl,
        string calldata milestone,
        uint256 value,
        string calldata metadataURI
    ) external onlyOracle returns (bytes32 uid) {
        if (bytes(milestone).length == 0) {
            revert EmptyString();
        }

        bytes32 repoId = _getRepoId(repoUrl);
        _requireRepository(repoId);

        uid = _attest(
            milestoneSchema,
            _recipientFor(repoId),
            abi.encode(repoUrl, milestone, value, metadataURI)
        );

        _recordAttestation(repoId, uid, "milestone", value);
        emit ImpactAttestationCreated(repoId, uid, milestone, value);
    }

    /// @notice Mints an attestation for a drip list (a verified funding list).
    ///         Oracle only. The list contents live in the resolvable metadata URI.
    /// @param metadataURI A URI resolving to the drip list manifest.
    /// @return uid The UID of the minted attestation.
    function attestDripList(string calldata metadataURI) external onlyOracle returns (bytes32 uid) {
        if (bytes(metadataURI).length == 0) {
            revert EmptyString();
        }

        uid = _attest(dripListSchema, msg.sender, abi.encode(metadataURI));

        emit DripListAttested(uid, msg.sender, metadataURI);
    }

    /// @notice Revokes an impact attestation previously minted for a repo. Oracle only.
    function revokeImpactAttestation(bytes32 repoId, bytes32 uid) external onlyOracle {
        RepoAttestationRecord memory record = _attestationRecords[uid];
        if (record.createdAt == 0 || record.repoId != repoId) {
            revert AttestationNotFound();
        }

        bytes32 schema = _schemaForKind(record.kind);
        _revoke(schema, uid);
    }

    /// @notice Derives a repository id from its URL.
    function getRepoId(string calldata repoUrl) external pure returns (bytes32) {
        return _getRepoId(repoUrl);
    }

    /// @dev Mints an attestation through EAS and returns its UID.
    function _attest(bytes32 schema, address recipient, bytes memory data) internal returns (bytes32 uid) {
        uid = eas.attest(
            AttestationRequest({
                schema: schema,
                data: AttestationRequestData({
                    recipient: recipient,
                    expirationTime: 0,
                    revocable: true,
                    refUID: 0,
                    data: data,
                    value: 0
                })
            })
        );

        if (uid == 0) {
            revert EmptyUid();
        }
    }

    function _revoke(bytes32 schema, bytes32 uid) internal {
        eas.revoke(
            RevocationRequest({
                schema: schema,
                data: RevocationRequestData({ uid: uid, value: 0 })
            })
        );
    }

    function _recordAttestation(bytes32 repoId, bytes32 uid, string memory kind, uint256 value) internal {
        _repoAttestations[repoId].push(uid);
        _attestationRecords[uid] = RepoAttestationRecord({
            repoId: repoId,
            kind: kind,
            value: value,
            createdAt: block.timestamp
        });
    }

    function _schemaForKind(string memory kind) internal view returns (bytes32) {
        if (keccak256(abi.encodePacked(kind)) == keccak256("badge")) {
            return impactBadgeSchema;
        }
        if (keccak256(abi.encodePacked(kind)) == keccak256("milestone")) {
            return milestoneSchema;
        }
        revert RepositoryNotFound();
    }

    function _recipientFor(bytes32 repoId) internal view returns (address) {
        address owner = _repositories[repoId].owner;
        return owner != address(0) ? owner : msg.sender;
    }

    function _requireRepository(bytes32 repoId) internal view {
        if (_repositories[repoId].id == 0) {
            revert RepositoryNotFound();
        }
    }

    function _getRepoId(string memory repoUrl) internal pure returns (bytes32) {
        return keccak256(bytes(repoUrl));
    }
}
