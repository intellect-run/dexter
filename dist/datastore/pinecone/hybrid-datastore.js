import { AbstractHybridDatastore } from '../hybrid-datastore.js';
import { createPineconeClient } from './client.js';
export class PineconeHybridDatastore extends AbstractHybridDatastore {
    datastoreType = 'hybrid';
    datastoreProvider = 'pinecone';
    pinecone;
    constructor(args) {
        const { pinecone, ...rest } = args;
        super(rest);
        this.pinecone =
            pinecone ||
                createPineconeClient({
                    namespace: this.namespace,
                });
    }
    async runQuery(query, context) {
        const mergedContext = { ...this.context, ...context };
        // Get the query embedding and sparse vector
        const queryEmbedding = query.embedding;
        const querySparseVector = query.sparseVector;
        const [{ embeddings }, { vectors: [sparseVector], },] = await Promise.all([
            queryEmbedding
                ? { embeddings: [queryEmbedding] }
                : this.embeddingModel.run({
                    input: [query.query],
                }, mergedContext),
            querySparseVector
                ? { vectors: [querySparseVector] }
                : this.spladeModel.run({
                    input: [query.query],
                }, mergedContext),
        ]);
        const embedding = embeddings[0];
        // Query Pinecone
        const response = await this.pinecone.query({
            topK: query.topK ?? 10,
            ...(typeof query.minScore === 'number'
                ? { minScore: query.minScore }
                : {}),
            ...(query.filter && { filter: query.filter }),
            ...(typeof query.hybridAlpha === 'number' && {
                hybridAlpha: query.hybridAlpha,
            }),
            includeValues: query.includeValues ?? false,
            includeMetadata: true,
            vector: embedding,
            sparseVector: sparseVector,
        });
        const queryResult = {
            query: query.query,
            docs: response.matches,
        };
        return queryResult;
    }
    async upsert(docs, context) {
        const mergedContext = { ...this.context, ...context };
        try {
            // Get the text from the docs that are missing embeddings or sparse vectors
            const textsToEmbed = docs
                .filter((doc) => doc.embedding == null || doc.sparseVector == null)
                .map((doc) => {
                const content = doc.metadata[this.contentKey];
                if (typeof content !== 'string') {
                    throw new Error(`The value of the contentKey (${String(this.contentKey)}) must be a string`);
                }
                return content;
            });
            if (textsToEmbed.length === 0) {
                return this.pinecone.upsert({
                    vectors: docs.map((doc, i) => ({
                        id: doc.id,
                        values: docs[i].embedding,
                        sparseValues: docs[i].sparseVector,
                        metadata: doc.metadata,
                    })),
                });
            }
            // Create the embeddings and sparse vectors
            // This relies on the classes to handle batching and throttling
            const [embeddingRes, spladeRes] = await Promise.all([
                this.embeddingModel.run({ input: textsToEmbed }, mergedContext),
                this.spladeModel.run({ input: textsToEmbed }, mergedContext),
            ]);
            const embeddings = embeddingRes.embeddings;
            // Merge the existing embeddings and sparse vectors with the generated ones
            const docsWithEmbeddings = docs.map((doc) => {
                let embedding = doc.embedding;
                let sparseVector = doc.sparseVector;
                // If the doc was missing an embedding or sparse vector, use the generated values
                if (embedding == null || sparseVector == null) {
                    embedding = embeddings.shift();
                    sparseVector = spladeRes.vectors.shift();
                    if (embedding == null || sparseVector == null) {
                        throw new Error('Unexpected missing embedding or sparse vector');
                    }
                }
                return {
                    ...doc,
                    embedding,
                    sparseVector,
                };
            });
            // Combine the results into Pinecones vector format and upsert
            return this.pinecone.upsert({
                vectors: docs.map((doc, i) => ({
                    id: doc.id,
                    values: docsWithEmbeddings[i].embedding,
                    sparseValues: docsWithEmbeddings[i].sparseVector,
                    metadata: doc.metadata,
                })),
            });
        }
        catch (error) {
            await Promise.allSettled(this.events?.onError?.map((event) => Promise.resolve(event({
                timestamp: new Date().toISOString(),
                datastoreType: this.datastoreType,
                datastoreProvider: this.datastoreProvider,
                error,
                context: mergedContext,
            }))) ?? []);
            throw error;
        }
    }
    async delete(docIds) {
        return this.pinecone.delete({ ids: docIds });
    }
    async deleteAll() {
        return this.pinecone.delete({ deleteAll: true });
    }
}
//# sourceMappingURL=hybrid-datastore.js.map