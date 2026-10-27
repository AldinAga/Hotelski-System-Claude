import { migrate } from './migrate';
import { createPool } from './pool';

async function main(): Promise<void> {
  const pool = createPool();
  try {
    const applied = await migrate(pool);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'nothing to apply');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
