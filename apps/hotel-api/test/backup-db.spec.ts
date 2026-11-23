import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

// infrastructure/nas/backup-db.sh with a fake `docker` in front: the script is
// run for real, only the container is imitated. deploy.sh itself cannot run here
// (it needs gh, the NAS and a green GitHub run); this pins the part that decides
// whether a deploy may go on.

const run = promisify(execFile);
const SCRIPT = resolve(__dirname, '../../../infrastructure/nas/backup-db.sh');
const SHA = 'a'.repeat(40);

const DUMP = '--\n-- PostgreSQL database dump\n--\nCREATE TABLE t (id int);\n--\n-- PostgreSQL database dump complete\n--\n';

describe('infrastructure/nas/backup-db.sh', () => {
  let dir: string;
  let backups: string;
  let docker: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hotel-backup-'));
    backups = join(dir, 'backup');
    docker = join(dir, 'docker');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A fake docker: `ps -a` lists the container (or not), `inspect` says running, `exec` prints `dump`. */
  function fakeDocker(opts: { exists?: boolean; running?: boolean; dump?: string; execExit?: number }): void {
    const { exists = true, running = true, dump = DUMP, execExit = 0 } = opts;
    const dumpFile = join(dir, 'dump.txt');
    writeFileSync(dumpFile, dump);
    writeFileSync(
      docker,
      `#!/bin/sh
case "$1" in
  ps) ${exists ? 'echo hotel-postgres-claude' : 'true'} ;;
  inspect) echo ${running ? 'true' : 'false'} ;;
  exec) cat '${dumpFile}'; exit ${execExit} ;;
  *) echo "unexpected docker $*" >&2; exit 99 ;;
esac
`,
    );
    chmodSync(docker, 0o755);
  }

  async function backup(sha = SHA): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await run('bash', [SCRIPT, sha], {
        env: { PATH: process.env.PATH ?? '', DOCKER: docker, BACKUP_DIR: backups },
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  const mode = (p: string) => statSync(p).mode & 0o777;

  it('writes the dump compressed, file mode 600 in a directory with mode 700', async () => {
    fakeDocker({});
    const r = await backup();
    expect(r.code).toBe(0);
    const file = join(backups, `${SHA}.sql.gz`);
    expect(gunzipSync(readFileSync(file)).toString()).toBe(DUMP);
    expect(mode(file)).toBe(0o600);
    expect(mode(backups)).toBe(0o700);
    expect(readdirSync(backups)).toEqual([`${SHA}.sql.gz`]);
  });

  it('stops, and leaves no file, when pg_dump fails', async () => {
    fakeDocker({ execExit: 1 });
    const r = await backup();
    expect(r.code).toBe(1);
    expect(readdirSync(backups)).toEqual([]);
  });

  it('stops when the dump is empty (a gzip of nothing is not a backup)', async () => {
    fakeDocker({ dump: '' });
    const r = await backup();
    expect(r.code).toBe(1);
    expect(readdirSync(backups)).toEqual([]);
  });

  it('stops when the dump is cut off before its closing line', async () => {
    fakeDocker({ dump: '--\n-- PostgreSQL database dump\n--\nCREATE TABLE t (id int);\n' });
    const r = await backup();
    expect(r.code).toBe(1);
    expect(readdirSync(backups)).toEqual([]);
  });

  it('stops when the container exists but is not running', async () => {
    fakeDocker({ running: false });
    const r = await backup();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not running');
  });

  it('a first deploy (no container yet) has nothing to copy and does not fail', async () => {
    fakeDocker({ exists: false });
    const r = await backup();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('nothing to copy');
  });

  it('keeps the 3 newest dumps', async () => {
    fakeDocker({});
    mkdirSync(backups, { recursive: true });
    const old = ['1', '2', '3'].map((c) => `${c.repeat(40)}.sql.gz`);
    old.forEach((name, i) => {
      const p = join(backups, name);
      writeFileSync(p, 'x');
      const at = new Date(2026, 0, 1 + i);
      utimesSync(p, at, at);
    });
    expect((await backup()).code).toBe(0);
    expect(readdirSync(backups).sort()).toEqual([old[1], old[2], `${SHA}.sql.gz`].sort());
  });

  it('deploy.sh runs it after the build and the database guard and before the tag moves and any container starts', () => {
    const deploy = readFileSync(resolve(__dirname, '../../../infrastructure/nas/deploy.sh'), 'utf8');
    const at = (needle: string) => {
      const i = deploy.indexOf(needle);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    const backup = at('infrastructure/nas/backup-db.sh $SHA');
    expect(backup).toBeGreaterThan(at('buildx build'));
    expect(backup).toBeGreaterThan(at('would be recreated; deploy stopped'));
    expect(backup).toBeLessThan(at('tag hotel-claude:$SHA hotel-claude:staging'));
    expect(backup).toBeLessThan(at('up -d --no-deps --remove-orphans --wait api web'));
  });

  it('refuses a ref that is not a hex commit id', async () => {
    fakeDocker({});
    expect((await backup('../etc')).code).toBe(1);
  });
});
