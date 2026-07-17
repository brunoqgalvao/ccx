import type { Api } from './api';
import type { Keychain } from './keychain';
import type { Config, Gauge, State } from './types';

export interface Deps {
  cfg: Config;
  state: State;
  saveState: (s: State) => void;
  appendHistory: (account: string, gauges: Gauge[], now: Date) => void;
  kc: Keychain;
  api: Api;
  now: () => Date;
  notify: (title: string, message: string) => void;
}
