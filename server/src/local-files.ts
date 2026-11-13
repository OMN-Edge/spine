/**
 * Whether this process keeps anything on the machine's disk. With the accounts in Postgres (`SPINE_STORE=postgres`) and the sealed bytes in a bucket
 * (`SPINE_OBJECTS=gcs`) it keeps nothing: no database file, no object, no backup to mirror, no directory to close to other users, no free space to
 * guard, so an instance holds no state and can be replaced, or added to, at any moment (docs/deploy-cloud-run.md). With either one still on this
 * machine, the data directory is used as it always was.
 *
 * What is read and not kept stays a file: the country database (`SPINE_GEOIP_DB`, in the image) and the operator's fair-use ceilings
 * (`SPINE_FAIR_USE_FILE`, a mounted secret).
 */
export function keepsFilesHere(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SPINE_STORE ?? 'sqlite') === 'sqlite' || (env.SPINE_OBJECTS ?? 'filesystem') === 'filesystem';
}
