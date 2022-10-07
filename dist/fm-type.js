import { Type } from '@sinclair/typebox';
const FrontMatterRequired = Type.Object({
    title: Type.String(),
    /**
     * Write like 2022-09-30 04:18
     *
     * It will be stored as ISO 8601 date format after processed.
     */
    writtenDate: Type.String(),
});
const FrontMatterOptional = Type.Partial(Type.Object({
    /**
    * If not set, it will grab from first sections of markdown content.
    */
    description: Type.String(),
    category: Type.Array(Type.String())
}));
/**
 * These metadatas will be stripped after processed.
 */
const FrontMatterOptionalStripped = Type.Partial(Type.Object({
    /**
     * If not set, its file name(without extension) will be used. Duplicate name is not allowed.
     * TODO: Maybe set proper regex (url-safe?)
     */
    name: Type.String(),
    /**
     * If set to true, it will not be included in processed.
     */
    noPublish: Type.Boolean()
}));
export const FrontMatterYaml = Type.Intersect([FrontMatterRequired, FrontMatterOptional, FrontMatterOptionalStripped], { additionalProperties: false });
