/** Sources that are a company's own ATS (preferred as a job's primary link; support single-posting fetch). */
export const ATS_SOURCE_KEYS: readonly string[] = ['greenhouse', 'lever', 'ashby', 'workday', 'icims'];

export type RunStatus = 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
