/** Minimal ABI subsets used by the backend (viem). Must stay in sync with the registry contract. */

export const registryAbi = [
  {
    type: "function",
    name: "oracle",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "eas",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "impactBadgeSchema",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "milestoneSchema",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "dripListSchema",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "repository",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "id", type: "bytes32" },
          { name: "repoUrl", type: "string" },
          { name: "name", type: "string" },
          { name: "packageType", type: "string" },
          { name: "owner", type: "address" },
          { name: "metadataURI", type: "string" },
          { name: "active", type: "bool" },
          { name: "registeredAt", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getRepoId",
    stateMutability: "pure",
    inputs: [{ name: "repoUrl", type: "string" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "registerRepository",
    stateMutability: "nonpayable",
    inputs: [
      { name: "repoUrl", type: "string" },
      { name: "name", type: "string" },
      { name: "packageType", type: "string" },
      { name: "owner", type: "address" },
      { name: "metadataURI", type: "string" },
    ],
    outputs: [{ name: "repoId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "updateRepository",
    stateMutability: "nonpayable",
    inputs: [
      { name: "repoId", type: "bytes32" },
      { name: "name", type: "string" },
      { name: "packageType", type: "string" },
      { name: "owner", type: "address" },
      { name: "metadataURI", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setRepositoryActive",
    stateMutability: "nonpayable",
    inputs: [
      { name: "repoId", type: "bytes32" },
      { name: "active", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "attestImpactBadge",
    stateMutability: "nonpayable",
    inputs: [
      { name: "repoUrl", type: "string" },
      { name: "badge", type: "string" },
      { name: "score", type: "uint256" },
      { name: "metadataURI", type: "string" },
    ],
    outputs: [{ name: "uid", type: "bytes32" }],
  },
  {
    type: "function",
    name: "attestMilestone",
    stateMutability: "nonpayable",
    inputs: [
      { name: "repoUrl", type: "string" },
      { name: "milestone", type: "string" },
      { name: "value", type: "uint256" },
      { name: "metadataURI", type: "string" },
    ],
    outputs: [{ name: "uid", type: "bytes32" }],
  },
  {
    type: "function",
    name: "attestDripList",
    stateMutability: "nonpayable",
    inputs: [{ name: "metadataURI", type: "string" }],
    outputs: [{ name: "uid", type: "bytes32" }],
  },
  {
    type: "function",
    name: "revokeImpactAttestation",
    stateMutability: "nonpayable",
    inputs: [
      { name: "repoId", type: "bytes32" },
      { name: "uid", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "verifyAttestation",
    stateMutability: "view",
    inputs: [{ name: "uid", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "repositoryAttestations",
    stateMutability: "view",
    inputs: [{ name: "repoId", type: "bytes32" }],
    outputs: [{ name: "", type: "bytes32[]" }],
  },
  {
    type: "event",
    name: "RepositoryRegistered",
    inputs: [
      { name: "repoId", type: "bytes32", indexed: true },
      { name: "repoUrl", type: "string", indexed: false },
      { name: "name", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ImpactAttestationCreated",
    inputs: [
      { name: "repoId", type: "bytes32", indexed: true },
      { name: "uid", type: "bytes32", indexed: true },
      { name: "attestationType", type: "string", indexed: false },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "DripListAttested",
    inputs: [
      { name: "uid", type: "bytes32", indexed: true },
      { name: "attester", type: "address", indexed: true },
      { name: "metadataURI", type: "string", indexed: false },
    ],
  },
] as const;

export const easAbi = [
  {
    type: "function",
    name: "getAttestation",
    stateMutability: "view",
    inputs: [{ name: "uid", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "uid", type: "bytes32" },
          { name: "schema", type: "bytes32" },
          { name: "time", type: "uint64" },
          { name: "expirationTime", type: "uint64" },
          { name: "revocationTime", type: "uint64" },
          { name: "refUID", type: "bytes32" },
          { name: "recipient", type: "address" },
          { name: "attester", type: "address" },
          { name: "revocable", type: "bool" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getSchema",
    stateMutability: "view",
    inputs: [{ name: "uid", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "uid", type: "bytes32" },
          { name: "resolver", type: "address" },
          { name: "revocable", type: "bool" },
          { name: "schema", type: "string" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "Attested",
    inputs: [
      { name: "recipient", type: "address", indexed: true },
      { name: "attester", type: "address", indexed: true },
      { name: "schemaUID", type: "bytes32", indexed: true },
      { name: "uid", type: "bytes32", indexed: false },
    ],
  },
] as const;
