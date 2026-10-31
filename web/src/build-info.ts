// The commit this build is of: `vite.config.ts` writes it in at build time (SPINE_COMMIT, or git), `dev` in the dev server and the tests.
// docs/verify-build.md: build this commit and compare it with the site.
declare const __SPINE_COMMIT__: string | undefined;

export const BUILD_COMMIT: string = typeof __SPINE_COMMIT__ === 'string' ? __SPINE_COMMIT__ : 'dev';
