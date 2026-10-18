/// <reference path="../pb_data/types.d.ts" />
// cards: atomic notes and flashcard units (HANDOVER §7.2).
migrate((app) => {
  const topics = app.findCollectionByNameOrId("topics");
  const collection = new Collection({
    type: "base",
    name: "cards",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: "select", name: "project", required: true, maxSelect: 1, values: ["english", "japanese", "maths", "dsa"] },
      { type: "relation", name: "topic", required: true, collectionId: topics.id, maxSelect: 1, cascadeDelete: false },
      { type: "text", name: "kind", required: true, max: 50 },
      { type: "text", name: "front", required: true, max: 500 },
      { type: "text", name: "back", required: true, max: 10000 },
      { type: "text", name: "extra", max: 10000 },
      { type: "json", name: "tags", maxSize: 5000 },
      { type: "json", name: "meta", maxSize: 50000 },
      { type: "bool", name: "suspended" },
      // SRS state, managed by the hook only.
      { type: "date", name: "due" },
      { type: "number", name: "interval_days", min: 0 },
      { type: "number", name: "ease", min: 0 },
      { type: "number", name: "reps", min: 0, onlyInt: true },
      { type: "number", name: "lapses", min: 0, onlyInt: true },
      { type: "number", name: "last_grade", min: 0, max: 4, onlyInt: true },
      { type: "date", name: "last_reviewed" },
      { type: "number", name: "mastery", min: 0, max: 1 },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE INDEX idx_cards_project_due ON cards (project, due)",
      "CREATE INDEX idx_cards_topic ON cards (topic)",
      "CREATE INDEX idx_cards_project_kind ON cards (project, kind)",
      "CREATE INDEX idx_cards_project_mastery ON cards (project, mastery)",
    ],
  });
  app.save(collection);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("cards"));
});
