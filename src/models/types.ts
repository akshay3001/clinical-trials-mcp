import { z } from 'zod';

// Search parameters schema
export const SearchParamsSchema = z.object({
  query: z.string().optional(),
  condition: z.string().optional(),
  intervention: z.string().optional(),
  phase: z.string().optional(),
  status: z.string().optional(),
  location: z.string().optional(),
  sponsorSearch: z.string().optional(),
  enrollmentMin: z.number().optional(),
  enrollmentMax: z.number().optional(),
  startDateAfter: z.string().optional(),
  startDateBefore: z.string().optional(),
  pageSize: z.number().min(1).max(1000).default(100),
  pageToken: z.string().optional(),
  fields: z.array(z.string()).optional(),
});

export type SearchParams = z.infer<typeof SearchParamsSchema>;

// Study protocol section schemas
export const IdentificationModuleSchema = z.object({
  nctId: z.string(),
  orgStudyIdInfo: z.object({
    id: z.string(),
  }).optional(),
  briefTitle: z.string(),
  officialTitle: z.string().optional(),
  acronym: z.string().optional(),
});

export const StatusModuleSchema = z.object({
  statusVerifiedDate: z.string().optional(),
  overallStatus: z.string(),
  lastKnownStatus: z.string().optional(),
  expandedAccessInfo: z.object({
    hasExpandedAccess: z.boolean().optional(),
  }).optional(),
  startDateStruct: z.object({
    date: z.string(),
    type: z.enum(['ACTUAL', 'ESTIMATED']).optional(),
  }).optional(),
  primaryCompletionDateStruct: z.object({
    date: z.string(),
    type: z.enum(['ACTUAL', 'ESTIMATED']).optional(),
  }).optional(),
  completionDateStruct: z.object({
    date: z.string(),
    type: z.enum(['ACTUAL', 'ESTIMATED']).optional(),
  }).optional(),
  studyFirstSubmitDate: z.string().optional(),
  studyFirstPostDateStruct: z.object({
    date: z.string(),
    type: z.string().optional(),
  }).optional(),
  lastUpdatePostDateStruct: z.object({
    date: z.string(),
    type: z.string().optional(),
  }).optional(),
});

export const DescriptionModuleSchema = z.object({
  briefSummary: z.string().optional(),
  detailedDescription: z.string().optional(),
});

export const ConditionsModuleSchema = z.object({
  conditions: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
});

export const DesignModuleSchema = z.object({
  studyType: z.string(),
  phases: z.array(z.string()).optional(),
  designInfo: z.object({
    allocation: z.string().optional(),
    interventionModel: z.string().optional(),
    primaryPurpose: z.string().optional(),
    maskingInfo: z.object({
      masking: z.string().optional(),
    }).optional(),
  }).optional(),
  enrollmentInfo: z.object({
    count: z.number().optional(),
    type: z.enum(['ACTUAL', 'ESTIMATED']).optional(),
  }).optional(),
});

export const ArmsInterventionsModuleSchema = z.object({
  armGroups: z.array(z.object({
    label: z.string(),
    type: z.string().optional(),
    description: z.string().optional(),
    interventionNames: z.array(z.string()).optional(),
  })).optional(),
  interventions: z.array(z.object({
    type: z.string(),
    name: z.string(),
    description: z.string().optional(),
    armGroupLabels: z.array(z.string()).optional(),
    otherNames: z.array(z.string()).optional(),
  })).optional(),
});

export const EligibilityModuleSchema = z.object({
  eligibilityCriteria: z.string().optional(),
  healthyVolunteers: z.boolean().optional(),
  sex: z.string().optional(),
  genderBased: z.boolean().optional(),
  minimumAge: z.string().optional(),
  maximumAge: z.string().optional(),
  stdAges: z.array(z.string()).optional(),
});

export const ContactsLocationsModuleSchema = z.object({
  centralContacts: z.array(z.object({
    name: z.string().optional(),
    role: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
  })).optional(),
  locations: z.array(z.object({
    facility: z.string().optional(),
    status: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    zip: z.string().optional(),
    country: z.string().optional(),
    geoPoint: z.object({
      lat: z.number(),
      lon: z.number(),
    }).optional(),
  })).optional(),
});

export const SponsorCollaboratorsModuleSchema = z.object({
  leadSponsor: z.object({
    name: z.string(),
    class: z.string().optional(),
  }).optional(),
  collaborators: z.array(z.object({
    name: z.string(),
    class: z.string().optional(),
  })).optional(),
});

export const ProtocolSectionSchema = z.object({
  identificationModule: IdentificationModuleSchema,
  statusModule: StatusModuleSchema,
  descriptionModule: DescriptionModuleSchema.optional(),
  conditionsModule: ConditionsModuleSchema.optional(),
  designModule: DesignModuleSchema.optional(),
  armsInterventionsModule: ArmsInterventionsModuleSchema.optional(),
  eligibilityModule: EligibilityModuleSchema.optional(),
  contactsLocationsModule: ContactsLocationsModuleSchema.optional(),
  sponsorCollaboratorsModule: SponsorCollaboratorsModuleSchema.optional(),
});

export const StudySchema = z.object({
  protocolSection: ProtocolSectionSchema,
  hasResults: z.boolean().optional(),
});

export type Study = z.infer<typeof StudySchema>;

// Search response schema
export const SearchResponseSchema = z.object({
  studies: z.array(StudySchema),
  nextPageToken: z.string().optional(),
  totalCount: z.number().optional(),
});

export type SearchResponse = z.infer<typeof SearchResponseSchema>;

// Session for iterative refinement
export interface SearchSession {
  id: string;
  studies: Study[];
  createdAt: Date;
  lastAccessedAt: Date;
  searchParams: SearchParams;
}

// Export formats
export type ExportFormat = 'csv' | 'json' | 'jsonl';

// Filter params for refinement
export interface FilterParams {
  locationCountry?: string;
  locationState?: string;
  locationCity?: string;
  enrollmentMin?: number;
  enrollmentMax?: number;
  startDateAfter?: string;
  startDateBefore?: string;
  completionDateAfter?: string;
  completionDateBefore?: string;
  interventionType?: string;
  hasResults?: boolean;
}
