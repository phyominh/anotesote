/// <reference path="../pb_data/types.d.ts" />
// links: typed graph edges, card↔card or topic↔topic (HANDOVER §7.4).
migrate((app) => {
  const topics = app.findCollectionByNameOrId("topics");
  const cards = app.findCollectionByNameOrId("cards");
  const collection = new Collection({
    type: "base",
    name: "links",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: "select", name: "project", required: true, maxSelect: 1, values: ["english", "japanese", "maths", "dsa"] },
      {
        type: "select", name: "type", required: true, maxSelect: 1,
        values: ["related", "prerequisite", "leads_to", "example_of", "contrasts", "part_of", "confused_with"],
      },
      { type: "relation", name: "from_card", collectionId: cards.id, maxSelect: 1, cascadeDelete: true },
      { type: "relation", name: "to_card", collectionId: cards.id, maxSelect: 1, cascadeDelete: true },
      { type: "relation", name: "from_topic", collectionId: topics.id, maxSelect: 1, cascadeDelete: true },
      { type: "relation", name: "to_topic", collectionId: topics.id, maxSelect: 1, cascadeDelete: true },
      { type: "text", name: "label", max: 200 },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE INDEX idx_links_from_card ON links (from_card)",
      "CREATE INDEX idx_links_to_card ON links (to_card)",
      "CREATE INDEX idx_links_from_topic ON links (from_topic)",
      "CREATE INDEX idx_links_to_topic ON links (to_topic)",
    ],
  });
  app.save(collection);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("links"));
});
