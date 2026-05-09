/// <reference types="vite/client" />

import type { SikApi } from './types';

declare global {
	interface Window {
		sik?: SikApi;
	}
}
