import Database from 'better-sqlite3';

import type { Db } from '../../db/connection.js';
import { ConflictError } from '../../errors/index.js';
import type { Coin, NewCoin } from './coins.types.js';

interface CoinRow {
  id: number;
  cmc_id: number;
  symbol: string;
  name: string;
  slug: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface InsertCoinParams {
  cmcId: number;
  symbol: string;
  name: string;
  slug: string;
  now: string;
}

interface SymbolParams {
  symbol: string;
}

interface ListParams {
  isActive: number | null;
  limit: number;
  offset: number;
}

interface ActiveFilterParams {
  isActive: number | null;
}

interface SetActiveParams {
  symbol: string;
  isActive: number;
  now: string;
}

interface CountRow {
  total: number;
}

const COIN_COLUMNS = 'id, cmc_id, symbol, name, slug, is_active, created_at, updated_at';

const INSERT_COIN =
  'INSERT INTO coins (cmc_id, symbol, name, slug, is_active, created_at, updated_at) ' +
  'VALUES (@cmcId, @symbol, @name, @slug, 1, @now, @now) ' +
  'RETURNING ' +
  COIN_COLUMNS;

const SELECT_BY_SYMBOL = 'SELECT ' + COIN_COLUMNS + ' FROM coins WHERE symbol = @symbol';

const SELECT_PAGE =
  'SELECT ' +
  COIN_COLUMNS +
  ' FROM coins WHERE (@isActive IS NULL OR is_active = @isActive) ' +
  'ORDER BY symbol LIMIT @limit OFFSET @offset';

const COUNT_FILTERED =
  'SELECT COUNT(*) AS total FROM coins WHERE (@isActive IS NULL OR is_active = @isActive)';

const COUNT_ALL = 'SELECT COUNT(*) AS total FROM coins';

const UPDATE_ACTIVE =
  'UPDATE coins SET is_active = @isActive, updated_at = @now WHERE symbol = @symbol RETURNING ' + COIN_COLUMNS;

const DELETE_BY_SYMBOL = 'DELETE FROM coins WHERE symbol = @symbol';

export class CoinsRepository {
  private readonly insertCoin: Database.Statement<[InsertCoinParams], CoinRow>;
  private readonly selectBySymbol: Database.Statement<[SymbolParams], CoinRow>;
  private readonly selectPage: Database.Statement<[ListParams], CoinRow>;
  private readonly countFiltered: Database.Statement<[ActiveFilterParams], CountRow>;
  private readonly countAll: Database.Statement<[], CountRow>;
  private readonly updateActive: Database.Statement<[SetActiveParams], CoinRow>;
  private readonly deleteCoin: Database.Statement<[SymbolParams]>;

  constructor(db: Db) {
    this.insertCoin = db.prepare(INSERT_COIN);
    this.selectBySymbol = db.prepare(SELECT_BY_SYMBOL);
    this.selectPage = db.prepare(SELECT_PAGE);
    this.countFiltered = db.prepare(COUNT_FILTERED);
    this.countAll = db.prepare(COUNT_ALL);
    this.updateActive = db.prepare(UPDATE_ACTIVE);
    this.deleteCoin = db.prepare(DELETE_BY_SYMBOL);
  }

  create(input: NewCoin, now: string): Coin {
    try {
      const row = this.insertCoin.get({
        cmcId: input.cmcId,
        symbol: input.symbol,
        name: input.name,
        slug: input.slug,
        now,
      });
      if (row === undefined) {
        throw new Error('Insert did not return a coin');
      }
      return toCoin(row);
    } catch (err) {
      if (err instanceof Database.SqliteError && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ConflictError('Coin ' + input.symbol + ' is already tracked', undefined, {
          constraint: err.message,
        });
      }
      throw err;
    }
  }

  findBySymbol(symbol: string): Coin | undefined {
    const row = this.selectBySymbol.get({ symbol });
    return row === undefined ? undefined : toCoin(row);
  }

  list(filter: { isActive?: boolean; limit: number; offset: number }): { items: Coin[]; total: number } {
    const params = {
      isActive: activeParam(filter.isActive),
      limit: filter.limit,
      offset: filter.offset,
    };
    return {
      items: this.selectPage.all(params).map(toCoin),
      total: requiredCount(this.countFiltered.get({ isActive: params.isActive })),
    };
  }

  setActive(symbol: string, isActive: boolean, now: string): Coin | undefined {
    const row = this.updateActive.get({
      symbol,
      isActive: isActive ? 1 : 0,
      now,
    });
    return row === undefined ? undefined : toCoin(row);
  }

  deleteBySymbol(symbol: string): boolean {
    return this.deleteCoin.run({ symbol }).changes > 0;
  }

  count(): number {
    return requiredCount(this.countAll.get());
  }
}

function activeParam(isActive: boolean | undefined): number | null {
  if (isActive === undefined) {
    return null;
  }
  return isActive ? 1 : 0;
}

function requiredCount(row: CountRow | undefined): number {
  if (row === undefined) {
    throw new Error('Failed to count coins');
  }
  return row.total;
}

function toCoin(row: CoinRow): Coin {
  return {
    id: row.id,
    cmcId: row.cmc_id,
    symbol: row.symbol,
    name: row.name,
    slug: row.slug,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
