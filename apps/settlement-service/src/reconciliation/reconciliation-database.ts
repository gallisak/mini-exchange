import { DataSource } from "typeorm";
import { reconciliationDataSourceOptions } from "../database/data-source";

export const RECONCILIATION_DATABASE = Symbol("RECONCILIATION_DATABASE");

export const reconciliationDatabase = {
  provide: RECONCILIATION_DATABASE,
  useFactory: () => new DataSource(reconciliationDataSourceOptions()).initialize(),
};
