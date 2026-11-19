import { redirect } from '@sveltejs/kit';
import { api, ApiError, type SessionInfo } from '$api/client';

export const load = async () => {
  let session: SessionInfo;
  try {
    session = await api.auth.session();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      redirect(303, '/login');
    }
    throw err;
  }
  return { session };
};

export type PageParentData = Awaited<ReturnType<typeof load>>;
