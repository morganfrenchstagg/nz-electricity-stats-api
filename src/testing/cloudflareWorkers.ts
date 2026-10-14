// stands in for the "cloudflare:workers" module in tests (see vitest.config.ts), with in-memory versions of the
// KV namespace and R2 buckets the worker uses. storage is emptied before each test (see setup.ts)
export const env = {} as Cloudflare.Env;

export function resetEnv() {
	Object.assign(env, {
		dispatch_kv: new FakeKVNamespace() as unknown as KVNamespace,
		dispatch: new FakeR2Bucket() as unknown as R2Bucket,
		offers: new FakeR2Bucket() as unknown as R2Bucket,
		EMI_API_KEY: "test-emi-api-key",
		SLACK_WEBHOOK_URL: "https://hooks.slack.test/services/test",
	});
}

// only the parts of the KV api the worker uses
class FakeKVNamespace {
	private entries = new Map<string, { value: string; metadata: unknown }>();

	async get(key: string): Promise<string | null> {
		return this.entries.get(key)?.value ?? null;
	}

	async getWithMetadata(key: string): Promise<{ value: string | null; metadata: unknown }> {
		const entry = this.entries.get(key);
		return { value: entry?.value ?? null, metadata: entry?.metadata ?? null };
	}

	async put(key: string, value: string, options?: { metadata?: unknown }) {
		this.entries.set(key, { value, metadata: options?.metadata ?? null });
	}

	async delete(key: string) {
		this.entries.delete(key);
	}
}

type FakeR2Object = {
	key: string;
	body: string;
	uploaded: Date;
};

// only the parts of the R2 api the worker uses. objects are listed in key order, as R2 does
class FakeR2Bucket {
	private objects = new Map<string, FakeR2Object>();

	async get(key: string) {
		const object = this.objects.get(key);
		if (!object) {
			return null;
		}
		return {
			...toListedObject(object),
			text: async () => object.body,
			json: async () => JSON.parse(object.body),
		};
	}

	async put(key: string, value: string) {
		if (typeof value !== "string") {
			throw new Error("FakeR2Bucket only supports string values");
		}
		const object = { key, body: value, uploaded: new Date() };
		this.objects.set(key, object);
		return toListedObject(object);
	}

	async delete(key: string) {
		this.objects.delete(key);
	}

	async list(options: { prefix?: string; startAfter?: string; cursor?: string; limit?: number } = {}) {
		const limit = options.limit ?? 1000;
		// the cursor is the key of the last object in the previous page
		const after = options.cursor ?? options.startAfter;

		const keys = [...this.objects.keys()]
			.filter(key => key.startsWith(options.prefix ?? "") && (after === undefined || key > after))
			.sort();
		const page = keys.slice(0, limit);
		const truncated = keys.length > limit;

		return {
			objects: page.map(key => toListedObject(this.objects.get(key)!)),
			truncated,
			cursor: truncated ? page[page.length - 1] : undefined,
			delimitedPrefixes: [],
		};
	}
}

function toListedObject(object: FakeR2Object) {
	return {
		key: object.key,
		size: object.body.length,
		uploaded: object.uploaded,
	};
}
