/// <reference path="../pb_data/types.d.ts" />
// topics: hierarchy and mind-map nodes (HANDOVER §7.1).
migrate((app) => {
  const collection = new Collection({
    type: "base",
    name: "topics",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: "select", name: "project", required: true, maxSelect: 1, values: ["english", "japanese", "maths", "dsa"] },
      { type: "text", name: "name", required: true, max: 120 },
      { type: "text", name: "path", required: true, max: 500 },
      { type: "text", name: "description", max: 2000 },
      { type: "number", name: "order" },
      { type: "number", name: "mastery", min: 0, max: 1 },
      { type: "number", name: "self_mastery", min: 0, max: 1 },
      { type: "number", name: "review_count", min: 0, onlyInt: true },
      { type: "date", name: "last_reviewed" },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_topics_project_path ON topics (project, path)",
    ],
  });
  app.save(collection);

  // Self-relation needs the collection id, so it is added after the first save.
  collection.fields.add(new RelationField({
    name: "parent",
    collectionId: collection.id,
    maxSelect: 1,
    cascadeDelete: false,
  }));
  collection.indexes.push("CREATE INDEX idx_topics_project_parent ON topics (project, parent)");
  app.save(collection);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("topics"));
});
