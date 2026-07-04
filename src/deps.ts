import type { Api } from './api';
import type { Keychain } from './keychain';
import type { Config, State } from './types';

export interface Deps {
  cfg: Config;
  state: State;
  saveState: (s: State) => void;
  kc: Keychain;
  api: Api;
  now: () => Date;
  notify: (title: string, message: string) => void;
}
