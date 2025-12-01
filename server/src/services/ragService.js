import chromaCollectionPromise from "../config/chroma.js";
import { logError } from "../utils/logger.js";

/**
 * Retrieve context chunks from ChromaDB for a given query.
 * You should have already ingested your documents into the same collection.
 */


// export async function getContextChunks({ query, topK = 8, orgId = null }) {
//   try {
//     const collection = await chromaCollectionPromise;

//     const where = {};
//     if (orgId) {
//       where.orgId = orgId;
//     }

//     const results = await collection.query({
//       queryTexts: [query],
//       nResults: topK,
//       where,
//     });

//     const documents = results.documents?.[0] || [];
//     const metadatas = results.metadatas?.[0] || [];
//     const distances = results.distances?.[0] || [];

//     const chunks = documents.map((doc, idx) => ({
//       content: doc,
//       metadata: metadatas[idx] || {},
//       distance: distances[idx] ?? null,
//     }));

//     return chunks;
//   } catch (err) {
//     logError("Error in getContextChunks:", err);
//     return [];
//   }
// }

export async function getContextChunks({ query }) {
  try {
    const collection = await chromaCollectionPromise;

    const results = await collection.query({
      queryTexts: [query],
      nResults: 1,                     // Only ask for ONE most relevant chunk
      include: ["documents", "distances"],
    });


    if (results.documents[0].length > 0) {
      return results.documents[0][0];
    } else {
      return "No data found";
    }

  } catch (err) {
    console.error("Error in getContextParagraph:", err);
    return "";
  }
}
