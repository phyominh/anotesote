/// <reference path="../pb_data/types.d.ts" />
// reviews: append-only grading log (HANDOVER §7.3).
migrate((app) => {
  const topics = app.findCollectionByNameOrId("topics");
  const cards = app.findCollectionByNameOrId("cards");
  const collection = new Collection({
    type: "base",
    name: "reviews",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: "select", name: "project", required: true, maxSelect: 1, values: ["english", "japanese", "maths", "dsa"] },
      { type: "relation", name: "topic", required: true, collectionId: topics.id, maxSelect: 1, cascadeDelete: true },
      { type: "relation", name: "card", collectionId: cards.id, maxSelect: 1, cascadeDelete: true },
      { type: "text", name: "exercise", required: true, max: 50 },
      { type: "text", name: "session", max: 100 },
      { type: "number", name: "grade", required: true, min: 1, max: 4, onlyInt: true },
      { type: "number", name: "score", min: 0, max: 100 },
      { type: "text", name: "comment", max: 2000 },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE INDEX idx_reviews_topic_created ON reviews (topic, created)",
      "CREATE INDEX idx_reviews_card_created ON reviews (card, created)",
      "CREATE INDEX idx_reviews_project_created ON reviews (project, created)",
      "CREATE INDEX idx_reviews_session ON reviews (session)",
    ],
  });
  app.save(collection);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("reviews"));
});
