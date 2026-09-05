import { z } from 'zod';
import { AppError } from '../../../errors/app-error.js';
import { metaGraphErrorSchema } from '../meta.schema.js';
import type { MetaApiContext } from '../meta.types.js';
import { computeMetaAppSecretProof } from '../meta.utils.js';
import type { MetaTrackingAd } from './meta-tracking.repository.js';

const metaIdResponseSchema = z.object({ id: z.string().min(1) });
const liveAdCreativeSchema = z.object({
  id: z.string().min(1),
  creative: z.object({ id: z.string().min(1) }).nullable().optional(),
});

export class MetaTrackingProvider {
  async cloneCreativeAndAssign(
    context: MetaApiContext,
    ad: MetaTrackingAd,
    urlTags: string,
  ): Promise<{ newCreativeId: string }> {
    const creative = ad.creative;
    if (!creative) {
      throw new AppError('Meta ad has no synced creative', 409, 'META_TRACKING_CREATIVE_MISSING');
    }

    const liveCreativeId = await this.fetchLiveCreativeId(context, ad.metaAdId);
    if (liveCreativeId !== creative.metaCreativeId) {
      throw new AppError(
        'Meta ad creative changed since the last Stride hierarchy sync; resync before applying tracking',
        409,
        'META_TRACKING_SNAPSHOT_STALE',
        {
          metaAdId: ad.metaAdId,
          syncedCreativeId: creative.metaCreativeId,
          liveCreativeId,
        },
      );
    }

    const createParams: Record<string, string> = {
      name: `${creative.name ?? ad.name} [Stride tracking]`.slice(0, 255),
      url_tags: urlTags,
    };

    if (creative.objectStoryId) {
      createParams.object_story_id = creative.objectStoryId;
    } else if (creative.objectStorySpec && !creative.assetFeedSpec) {
      createParams.object_story_spec = JSON.stringify(creative.objectStorySpec);
    } else {
      throw new AppError(
        'This Meta creative shape is not safe for automatic tracking setup',
        409,
        'META_TRACKING_AUTOMATION_UNSUPPORTED',
      );
    }

    // Preserve the synced creative-enhancement configuration regardless of whether the source
    // creative references an existing post or carries an object_story_spec. Automatic setup is
    // tracking-only and must not silently change Meta's enhancement behavior.
    if (creative.degreesOfFreedomSpec) {
      createParams.degrees_of_freedom_spec = JSON.stringify(creative.degreesOfFreedomSpec);
    }

    const created = metaIdResponseSchema.safeParse(
      await this.requestMutation(context, `/${ad.adAccount.metaAccountId}/adcreatives`, createParams),
    );
    if (!created.success) {
      throw new AppError(
        'Meta returned an invalid creative creation response',
        502,
        'META_BAD_RESPONSE',
      );
    }

    try {
      await this.requestMutation(context, `/${ad.metaAdId}`, {
        creative: JSON.stringify({ creative_id: created.data.id }),
      });
    } catch (error) {
      throw new AppError(
        error instanceof Error ? error.message : 'Meta ad creative assignment failed',
        error instanceof AppError ? error.statusCode : 502,
        error instanceof AppError ? error.code : 'META_REQUEST_FAILED',
        { createdCreativeId: created.data.id },
      );
    }

    return { newCreativeId: created.data.id };
  }

  private async fetchLiveCreativeId(context: MetaApiContext, metaAdId: string): Promise<string | null> {
    const url = new URL(`https://graph.facebook.com/${context.apiVersion}/${metaAdId}`);
    url.searchParams.set('fields', 'creative{id}');
    url.searchParams.set('appsecret_proof', computeMetaAppSecretProof(context.accessToken));

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${context.accessToken}` },
      });
    } catch {
      throw new AppError('Meta read request failed', 502, 'META_REQUEST_FAILED');
    }

    const payload = await this.parseResponse(response);
    const parsed = liveAdCreativeSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AppError('Meta returned an invalid ad creative response', 502, 'META_BAD_RESPONSE');
    }
    return parsed.data.creative?.id ?? null;
  }

  private async requestMutation(
    context: MetaApiContext,
    path: string,
    params: Record<string, string>,
  ): Promise<unknown> {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`https://graph.facebook.com/${context.apiVersion}${normalizedPath}`);
    const body = new URLSearchParams({
      ...params,
      appsecret_proof: computeMetaAppSecretProof(context.accessToken),
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${context.accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
    } catch {
      // Do not retry non-idempotent provider mutations automatically. A lost response could otherwise
      // create duplicate creatives. The merchant can resync/audit before retrying.
      throw new AppError('Meta write request failed', 502, 'META_REQUEST_FAILED');
    }

    return this.parseResponse(response);
  }

  private async parseResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        throw new AppError('Meta returned a non-JSON response', 502, 'META_BAD_RESPONSE');
      }
    }

    const graphError = metaGraphErrorSchema.safeParse(payload);
    if (response.ok && !graphError.success) return payload;

    if (graphError.success) {
      const code = graphError.data.error.code;
      if (code === 190) {
        throw new AppError(
          'Meta access token requires reauthorization',
          401,
          'META_REAUTH_REQUIRED',
        );
      }
      if (code === 200 || code === 10) {
        throw new AppError(
          `Meta permission error: ${graphError.data.error.message}`,
          403,
          'META_PERMISSION_DENIED',
        );
      }
      throw new AppError(
        `Meta API error: ${graphError.data.error.message}`,
        response.status >= 500 ? 502 : 400,
        'META_REQUEST_FAILED',
      );
    }

    throw new AppError(
      `Meta API request failed with HTTP ${response.status}`,
      response.status >= 500 ? 502 : 400,
      'META_REQUEST_FAILED',
    );
  }
}