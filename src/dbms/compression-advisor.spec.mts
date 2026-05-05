import { describe, expect, it } from 'vitest';
import { MockFile } from '../core/mockfile.mjs';
import { SimpleDbms } from './simpledbms.mjs';

describe('compression advisor', () => {
  it('lists all benchmark profiles for the UI dropdown', async () => {
    const db = await SimpleDbms.create(new MockFile(2048), new MockFile(4096));
    const profiles = db.listCompressionProfiles();

    expect(profiles.map((profile) => profile.id)).toContain('text.long-text');
    expect(profiles.map((profile) => profile.id)).toContain('image.jpeg-photo');
    expect(profiles.every((profile) => profile.displayName.length > 0)).toBe(true);

    await db.close();
  });

  it('recommends compression for cold long text', async () => {
    const db = await SimpleDbms.create(new MockFile(2_000_000), new MockFile(2_000_000));

    for (let i = 0; i < 4; i++) {
      await db.insertDocument(
        'articles',
        JSON.stringify({
          id: `article-${i}`,
          _content: 'Compression friendly text '.repeat(160),
        }),
      );
    }

    const recommendation = await db.recommendCompression({
      collection: 'articles',
      field: '_content',
      workload: 0,
    });

    expect(recommendation.detectedProfile.id).toBe('text.long-text');
    expect(recommendation.recommended).not.toBe('none');
    expect(['gzip', 'deflate', 'brotli', 'zstd-fast', 'zstd']).toContain(recommendation.ranking[0].algorithm);
    expect(recommendation.analysis.documentsScanned).toBeGreaterThan(0);
    expect(recommendation.ranking[0].storageEstimate?.rawBlocks).toBeGreaterThan(0);
    expect(recommendation.ranking[0].storageEstimate?.blocksSaved).toBeGreaterThanOrEqual(0);

    await db.close();
  });

  it('recommends none for hot long text', async () => {
    const db = await SimpleDbms.create(new MockFile(2_000_000), new MockFile(2_000_000));

    for (let i = 0; i < 4; i++) {
      await db.insertDocument(
        'articles',
        JSON.stringify({
          id: `article-${i}`,
          _content: 'Compression friendly text '.repeat(160),
        }),
      );
    }

    const recommendation = await db.recommendCompression({
      collection: 'articles',
      field: '_content',
      workload: 1,
    });

    expect(recommendation.detectedProfile.id).toBe('text.long-text');
    expect(recommendation.recommended).toBe('none');
    expect(recommendation.ranking[0].algorithm).toBe('none');

    await db.close();
  });

  it('supports profile override for the demo UI', async () => {
    const db = await SimpleDbms.create(new MockFile(2_000_000), new MockFile(2_000_000));

    const recommendation = await db.recommendCompression({
      collection: 'drafts',
      field: 'thumbnail.png',
      workload: 0.5,
      profileOverride: 'image.png-graphic',
      draftValue: Buffer.from('fake-image-binary').toString('base64'),
    });

    expect(recommendation.detectedProfile.kind).toBe('image');
    expect(recommendation.activeProfile.id).toBe('image.png-graphic');
    expect(recommendation.availableProfiles.length).toBeGreaterThan(3);

    await db.close();
  });

  it('includes block estimates when only a draft value is available', async () => {
    const db = await SimpleDbms.create(new MockFile(2_000_000), new MockFile(2_000_000));

    const recommendation = await db.recommendCompression({
      collection: 'drafts',
      field: '_content',
      workload: 0,
      draftValue: 'Draft-only compression advisor sample '.repeat(200),
    });

    expect(recommendation.analysis.documentsScanned).toBe(0);
    expect(recommendation.analysis.draftValueUsed).toBe(true);
    expect(recommendation.analysis.storageSamples).toBe(1);
    expect(recommendation.ranking.every((item) => item.storageEstimate !== null)).toBe(true);
    expect(recommendation.ranking[0].storageEstimate?.rawBlocks).toBeGreaterThan(0);

    await db.close();
  });
});
