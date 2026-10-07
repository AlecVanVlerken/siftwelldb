type Model = { explores: Array<{ collection: string; [key: string]: unknown }>; [key: string]: unknown };

export function mergeScopedModel(edited: Model, current: Model | null, collection: string | null): Model {
  if (!collection) return edited;
  if (
    !Array.isArray(edited?.explores) ||
    edited.explores.length !== 1 ||
    edited.explores[0]?.collection !== collection
  ) {
    throw new Error('Edit only the selected collection in this dialog.');
  }
  return {
    ...current,
    explores: [...(current?.explores || []).filter((explore) => explore.collection !== collection), edited.explores[0]],
  };
}
