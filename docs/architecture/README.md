# Architecture detail

[ARCHITECTURE.md](../../ARCHITECTURE.md) is the overview: where the code runs, the trust boundaries, the multi-user model, the request flow, what leaves the host, and what is not done. These pages hold the detail it points to.

- [interfaces.md](interfaces.md): the five interfaces (store, model, parser, embedder, mailer), how an implementation is chosen, and what each promises
- [ingestion.md](ingestion.md): from upload to documents, and the features built on the result: the document page, chat, care chains, episodes, similarity, the library, export and import
- [data.md](data.md): what is kept where, the schema and how it changes, and share links as sealed copies

The numbered principles these pages are held to are in [SECURITY.md](../../SECURITY.md); the decisions the code depends on, by area, are in [design-decisions.md](../design-decisions.md).
