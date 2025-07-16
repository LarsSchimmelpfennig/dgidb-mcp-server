export interface Interaction {
  /** Raw interaction score from the API (may be missing). */
  interactionScore?: number;
  /** Any additional fields returned by the API. */
  [key: string]: unknown;
}

export interface GeneNode {
  /** Gene (or molecular profile) name. */
  name: string;
  /** Array of interaction objects. */
  interactions: Interaction[];
  /** Any other fields returned by the API. */
  [key: string]: unknown;
}

/* ---------- 1. filterInteractionScore ---------- */

/**
 * Return the top N interactions sorted by highest `interactionScore`.
 *
 * @param interactions - Array of interaction objects.
 * @param N            - Maximum number to return (default 20).
 */
export function filterInteractionScore(
  interactions: Interaction[],
  N = 20
): Interaction[] {
  return [...interactions]                                  // copy so caller’s array stays untouched
    .sort(
      (a, b) =>
        (b.interactionScore ?? 0) - (a.interactionScore ?? 0)
    )
    .slice(0, N);
}

/* ---------- 2. findBestNode ---------- */

/**
 * Pick the “best” node, preferring an exact (case‑insensitive) name match;
 * otherwise return the node with the most interactions.
 *
 * @param nodes - Array of gene nodes.
 * @param term  - Name to match against `node.name`.
 * @returns     - The best‐matching node, or `undefined` if `nodes` is empty.
 */
export function findBestNode(
  nodes: GeneNode[],
  term: string
): GeneNode | undefined {
  if (nodes.length === 0) return undefined;

  const lowerTerm = term.toLowerCase();
  let bestNode: GeneNode = nodes[0];
  let largestSize = bestNode.interactions.length;

  for (const node of nodes) {
    // 1) Exact case‑insensitive match wins immediately
    if (node.name.toLowerCase() === lowerTerm) return node;

    // 2) Otherwise keep track of the node with the most interactions
    if (node.interactions.length > largestSize) {
      bestNode = node;
      largestSize = node.interactions.length;
    }
  }
  return bestNode;
}

const nodes: GeneNode[] = [
  { name: "ALKAL2", interactions: [] },
  {
    name: "ALK",
    interactions: [
      {
        drug: { name: "CEP-37440" },
        interactionScore: 0.2351522457607456,
        interactionTypes: [{ type: "inhibitor", directionality: "INHIBITORY" }],
      },
      {
        drug: { name: "ENTRECTINIB" },
        interactionScore: 0.09901147189926132,
        interactionTypes: [{ type: "inhibitor", directionality: "INHIBITORY" }],
      },
      {
        drug: { name: "VENETOCLAX" },
        interactionScore: 0.04275495377468102,
        interactionTypes: [],
      },
      {
        drug: { name: "CONTELTINIB" },
        interactionScore: 0.4703044915214913,
        interactionTypes: [{ type: "inhibitor", directionality: "INHIBITORY" }],
      },
      {
        drug: { name: "ALECTINIB" },
        interactionScore: 5.361471203345,
        interactionTypes: [{ type: "inhibitor", directionality: "INHIBITORY" }],
      },
      // …add more items if you’d like to see truncation to top 10
    ],
  },
];

/* ---------- run the functions ---------- */

const query = "ALK";               // try "Foo" to trigger fallback‑to‑largest
const node = findBestNode(nodes, query);

if (!node) {
  console.error("No suitable node found");
  process.exit(1);
}

const top10 = filterInteractionScore(node.interactions, 2);

/* ---------- pretty‑print results ---------- */

console.log(`Matched node: ${node.name} (${node.interactions.length} interactions)`);
console.table(
  top10.map(({ drug, interactionScore }) => ({
    drug: (drug as { name?: string })?.name ?? "—",
    interactionScore: interactionScore ?? 0,
  }))
);