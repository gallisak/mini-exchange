import './env';
import { migrate } from '../../src/database/migrate';

export default async function globalSetup(): Promise<void> {
  await migrate();
}
