import { CloudClient } from "chromadb";
import { DefaultEmbeddingFunction } from "@chroma-core/default-embed";
import dotenv from "dotenv";

dotenv.config();

// Create client with authentication
const client = new CloudClient({
  apiKey: process.env.CHROMA_API_KEY,
  tenant: process.env.CHROMA_TENANT,
  database: process.env.CHROMA_DATABASE,
});

// Initialize the default embedder
const embedder = new DefaultEmbeddingFunction();

// ⚠️ Use a *new* collection name to avoid schema mismatch
const chromaCollectionPromise = client.getOrCreateCollection({
  name: "mercedes_knowledge_v2", // <-- change this name if schema changes
  embeddingFunction: embedder,
});

export default chromaCollectionPromise;