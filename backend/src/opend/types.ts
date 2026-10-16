/** The shapes the moomoo WebSocket client returns (ADR 0009, phase 6).
 *
 *  Hand-written because the npm package ships no types at all: it is a protobuf client with a
 *  JavaScript surface and nothing describing it. These cover only what the service reads — writing
 *  all of it would be transcribing a schema we do not use, and a wrong guess in an unused field is
 *  worse than its absence.
 */

/** protobufjs decodes int64 to this rather than a number. */
export interface Long {
  low: number;
  high: number;
  unsigned: boolean;
}

export interface Security {
  market: number;
  code: string;
}

export interface QotBasic {
  security: Security;
  name?: string;
  isSuspend?: boolean;
  lotSize?: number;
  updateTime?: string;
  updateTimestamp?: number;
  curPrice?: number;
  openPrice?: number;
  highPrice?: number;
  lowPrice?: number;
  lastClosePrice?: number;
  askPrice?: number;
  bidPrice?: number;
  askVol?: Long | number;
  bidVol?: Long | number;
  volume?: Long | number;
  turnover?: number;
  turnoverRate?: number;
  amplitude?: number;
  avgPrice?: number;
  bidAskRatio?: number;
  priceSpread?: number;
  secStatus?: number;
}

export interface OptionExData {
  /** 1 = CALL, 2 = PUT */
  type?: number;
  /** the underlying, e.g. market 11 + ".SPX" */
  owner?: Security;
  strikeTime?: string;
  strikePrice?: number;
  contractSize?: number;
  contractSizeFloat?: number;
  contractMultiplier?: number;
  openInterest?: number;
  impliedVolatility?: number;
  premium?: number;
  delta?: number;
  gamma?: number;
  vega?: number;
  theta?: number;
  rho?: number;
  expiryDateDistance?: number;
  /** 1 = AMERICAN, 2 = EUROPEAN */
  optionAreaType?: number;
}

export interface Snapshot {
  basic: QotBasic;
  optionExData?: OptionExData;
}

export interface SnapshotResponse {
  retType: number;
  retMsg?: string;
  s2c?: { snapshotList?: Snapshot[] };
}

/** The one method of the client the service uses, plus its lifecycle. */
export interface MoomooClient {
  onlogin?: (ok: boolean, msg: unknown) => void;
  start(ip: string, port: number, ssl: boolean, key: string): void;
  /** The inner connection, and the ONLY thing that can hang it up.
   *
   *  `stop()` below is not that: it unregisters a push callback and returns. Nothing in the
   *  package's public surface closes a socket, so this is reached for deliberately — the library's
   *  own `start()` reaches for the same field to close the previous connection. Optional because a
   *  fake need not have one, and because a version that drops the field must not crash the sweep.
   */
  websock?: { close: () => void };
  GetSecuritySnapshot(req: {
    c2s: { securityList: Security[] };
  }): Promise<SnapshotResponse>;
  stop(): void;
}
