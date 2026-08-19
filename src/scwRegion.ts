import { z } from "zod";

export const SCW_REGIONS = ["fr-par", "nl-ams", "pl-waw"] as const;
export const scwRegionSchema = z.enum(SCW_REGIONS);
