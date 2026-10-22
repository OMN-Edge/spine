# Record of processing activities (Art. 30)

Controller: the operator of the service (for the hosted service, Omni Edge SRL), contact in the privacy notice. Data protection officer: none appointed; reassess when processing is at large scale (Art. 37).

| Activity | Data subjects | Data | Purpose and basis | Recipients | Transfers | Retention |
| --- | --- | --- | --- | --- | --- | --- |
| Accounts | Users | Email, password hash, consent records, sign-in records | Make and secure the account. Contract; legitimate interest | Hosting; email provider (messages only) | EU | Until the account is deleted; sign-in records up to 12 months |
| Records | Users, and the people the records are about (the user, or a child or relative managed by them) | Uploaded documents, text read from them, extracted details, notes, tags, doctors named, conversations with the assistant | Store, organise, search, translate and share the user's records. Explicit consent (Art. 9(2)(a)) | Hosting; model provider for the AI features the instance has switched on (the text or page of a request only); people the user shares with | EU endpoints; none outside the EU unless the operator configures one | Until deleted by the user; backups up to the retention period |
| Sharing | Users; recipients | Share links (stored only as a digest), scope, access log: time, address, country, documents opened | Let the user share and see who read it. Contract; legitimate interest | Hosting | EU | Until the link or account is deleted |
| Security | Users; visitors | Rate-limit counters, application log lines without content | Protect the service. Legitimate interest | Hosting | EU | Up to 12 months |

Technical and organisational measures: SECURITY.md (access limited by account on every query; passwords hashed with argon2id; optional second factor; TLS; backups; dependency and secret scanning in CI).
