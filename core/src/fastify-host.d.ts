// The routes in this package read what these Fastify plugins add (`request.session`, cookies, `config.rateLimit`). The host registers
// them: the server in index.ts, the device's LocalApp (web/src/core/local-app.ts) by emulating them. Importing them here is what makes
// the additions part of the types every consumer of this package sees.
import '@fastify/cookie';
import '@fastify/rate-limit';
import '@fastify/session';
