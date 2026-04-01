import { authenticateByAuthorizationHeader } from '../auth.js';

export type AstrologyRouteDependencies = {
  authenticateByAuthorizationHeader: typeof authenticateByAuthorizationHeader;
};

export type RegisterAstrologyRoutesOptions = {
  deps?: Partial<AstrologyRouteDependencies>;
};
