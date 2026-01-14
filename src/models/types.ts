import { z } from "zod";

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
  orgStudyIdInfo: z
    .object({
      id: z.string().optional(),
    })
    .passthrough()
    .optional(),
  briefTitle: z.string(),
  officialTitle: z.string().optional().default(""),
  acronym: z.string().optional().default(""),
  secondaryIdInfos: z.array(z.object({
    id: z.string().optional(),
    type: z.string().optional(),
    domain: z.string().optional(),
    link: z.string().optional(),
  }).passthrough()).optional().default([]),
  nctIdAliases: z.array(z.string()).optional().default([]),
  organization: z.object({
    fullName: z.string().optional(),
    class: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

export const StatusModuleSchema = z.object({
  statusVerifiedDate: z.string().optional(),
  overallStatus: z.string(),
  lastKnownStatus: z.string().optional(),
  whyStopped: z.string().optional(),
  delayedPosting: z.boolean().optional(),
  expandedAccessInfo: z
    .object({
      hasExpandedAccess: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
  startDateStruct: z
    .object({
      date: z.string().optional(),
      type: z.enum(["ACTUAL", "ESTIMATED"]).optional(),
    })
    .passthrough()
    .optional(),
  primaryCompletionDateStruct: z
    .object({
      date: z.string().optional(),
      type: z.enum(["ACTUAL", "ESTIMATED"]).optional(),
    })
    .passthrough()
    .optional(),
  completionDateStruct: z
    .object({
      date: z.string().optional(),
      type: z.enum(["ACTUAL", "ESTIMATED"]).optional(),
    })
    .passthrough()
    .optional(),
  studyFirstSubmitDate: z.string().optional(),
  studyFirstPostDateStruct: z
    .object({
      date: z.string().optional(),
      type: z.string().optional(),
    })
    .passthrough()
    .optional(),
  lastUpdatePostDateStruct: z
    .object({
      date: z.string().optional(),
      type: z.string().optional(),
    })
    .passthrough()
    .optional(),
}).passthrough();

export const DescriptionModuleSchema = z.object({
  briefSummary: z.string().optional().default(""),
  detailedDescription: z.string().optional().default(""),
}).passthrough();

export const ConditionsModuleSchema = z.object({
  conditions: z.array(z.string()).optional().default([]),
  keywords: z.array(z.string()).optional().default([]),
}).passthrough();

export const DesignModuleSchema = z.object({
  studyType: z.string().optional().default(""),
  phases: z.array(z.string()).optional().default([]),
  patientRegistry: z.boolean().optional(),
  targetDuration: z.string().optional(),
  designInfo: z
    .object({
      allocation: z.string().optional(),
      interventionModel: z.string().optional(),
      primaryPurpose: z.string().optional(),
      maskingInfo: z
        .object({
          masking: z.string().optional(),
          whoMasked: z.array(z.string()).optional().default([]),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
  enrollmentInfo: z
    .object({
      count: z.number().optional(),
      type: z.enum(["ACTUAL", "ESTIMATED"]).optional(),
    })
    .passthrough()
    .optional(),
}).passthrough();

export const ArmsInterventionsModuleSchema = z.object({
  armGroups: z
    .array(
      z.object({
        label: z.string().optional(),
        type: z.string().optional(),
        description: z.string().optional(),
        interventionNames: z.array(z.string()).optional().default([]),
      }).passthrough(),
    )
    .optional()
    .default([]),
  interventions: z
    .array(
      z.object({
        type: z.string().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        armGroupLabels: z.array(z.string()).optional().default([]),
        otherNames: z.array(z.string()).optional().default([]),
      }).passthrough(),
    )
    .optional()
    .default([]),
}).passthrough();

export const EligibilityModuleSchema = z.object({
  eligibilityCriteria: z.string().optional(),
  healthyVolunteers: z.boolean().optional(),
  sex: z.string().optional(),
  genderBased: z.boolean().optional(),
  genderDescription: z.string().optional(),
  minimumAge: z.string().optional(),
  maximumAge: z.string().optional(),
  stdAges: z.array(z.string()).optional().default([]),
  studyPopulation: z.string().optional(),
  samplingMethod: z.string().optional(),
}).passthrough();

export const ContactsLocationsModuleSchema = z.object({
  centralContacts: z
    .array(
      z.object({
        name: z.string().optional(),
        role: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
      }).passthrough(),
    )
    .optional()
    .default([]),
  locations: z
    .array(
      z.object({
        facility: z.string().optional(),
        status: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zip: z.string().optional(),
        country: z.string().optional(),
        geoPoint: z
          .object({
            lat: z.number().optional(),
            lon: z.number().optional(),
          })
          .passthrough()
          .optional(),
        contacts: z.array(z.object({
          name: z.string().optional(),
          role: z.string().optional(),
          phone: z.string().optional(),
          email: z.string().optional(),
        }).passthrough()).optional().default([]),
      }).passthrough(),
    )
    .optional()
    .default([]),
}).passthrough();

export const SponsorCollaboratorsModuleSchema = z.object({
  leadSponsor: z
    .object({
      name: z.string().optional(),
      class: z.string().optional(),
    })
    .passthrough()
    .optional(),
  collaborators: z
    .array(
      z.object({
        name: z.string().optional(),
        class: z.string().optional(),
      }).passthrough(),
    )
    .optional()
    .default([]),
  responsibleParty: z.object({
    type: z.string().optional(),
    investigatorFullName: z.string().optional(),
    investigatorTitle: z.string().optional(),
    investigatorAffiliation: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

export const OutcomesModuleSchema = z.object({
  primaryOutcomes: z
    .array(
      z.object({
        measure: z.string().optional(),
        description: z.string().optional(),
        timeFrame: z.string().optional(),
      }).passthrough(),
    )
    .optional()
    .default([]),
  secondaryOutcomes: z
    .array(
      z.object({
        measure: z.string().optional(),
        description: z.string().optional(),
        timeFrame: z.string().optional(),
      }).passthrough(),
    )
    .optional()
    .default([]),
  otherOutcomes: z
    .array(
      z.object({
        measure: z.string().optional(),
        description: z.string().optional(),
        timeFrame: z.string().optional(),
      }).passthrough(),
    )
    .optional()
    .default([]),
}).passthrough();

export const OversightModuleSchema = z.object({
  oversightHasDmc: z.boolean().optional(),
  isFdaRegulatedDrug: z.boolean().optional(),
  isFdaRegulatedDevice: z.boolean().optional(),
  isUnapprovedDevice: z.boolean().optional(),
  isPPSD: z.boolean().optional(),
  isUSExport: z.boolean().optional(),
}).passthrough();

export const ReferencesModuleSchema = z.object({
  references: z.array(z.object({
    pmid: z.string().optional(),
    type: z.string().optional(),
    citation: z.string().optional(),
  }).passthrough()).optional().default([]),
  seeAlsoLinks: z.array(z.object({
    label: z.string().optional(),
    url: z.string().optional(),
  }).passthrough()).optional().default([]),
  availIpds: z.array(z.object({
    id: z.string().optional(),
    type: z.string().optional(),
    url: z.string().optional(),
    comment: z.string().optional(),
  }).passthrough()).optional().default([]),
}).passthrough();

export const IpdSharingStatementModuleSchema = z.object({
  ipdSharing: z.string().optional(),
  description: z.string().optional(),
  infoTypes: z.array(z.string()).optional().default([]),
  timeFrame: z.string().optional(),
  accessCriteria: z.string().optional(),
  url: z.string().optional(),
}).passthrough();

export const ProtocolSectionSchema = z.object({
  identificationModule: IdentificationModuleSchema,
  statusModule: StatusModuleSchema,
  descriptionModule: DescriptionModuleSchema.optional(),
  conditionsModule: ConditionsModuleSchema.optional(),
  designModule: DesignModuleSchema.optional(),
  armsInterventionsModule: ArmsInterventionsModuleSchema.optional(),
  outcomesModule: OutcomesModuleSchema.optional(),
  eligibilityModule: EligibilityModuleSchema.optional(),
  contactsLocationsModule: ContactsLocationsModuleSchema.optional(),
  sponsorCollaboratorsModule: SponsorCollaboratorsModuleSchema.optional(),
  oversightModule: OversightModuleSchema.optional(),
  referencesModule: ReferencesModuleSchema.optional(),
  ipdSharingStatementModule: IpdSharingStatementModuleSchema.optional(),
}).passthrough();

export const StudySchema = z.object({
  protocolSection: ProtocolSectionSchema,
  hasResults: z.boolean().optional(),
  resultsSection: z.any().optional(),
  annotationSection: z.any().optional(),
  documentSection: z.any().optional(),
  derivedSection: z.any().optional(),
}).passthrough();

export type Study = z.infer<typeof StudySchema>;

// Define SearchResponse type explicitly
export interface SearchResponse {
  studies: Study[];
  nextPageToken?: string;
  totalCount?: number;
  [key: string]: any;
}

// Search response schema  
export const SearchResponseSchema: z.ZodSchema<SearchResponse> = z.object({
  studies: z.array(StudySchema).default([]),
  nextPageToken: z.string().optional(),
  totalCount: z.number().optional(),
}).passthrough() as any;

// Session for iterative refinement
export interface SearchSession {
  id: string;
  studies: Study[];
  createdAt: Date;
  lastAccessedAt: Date;
  searchParams: SearchParams;
}

// Export formats
export type ExportFormat = "csv" | "json" | "jsonl";

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
  // Phase 1 filters
  studyType?:
    | "INTERVENTIONAL"
    | "OBSERVATIONAL"
    | "EXPANDED_ACCESS"
    | "PATIENT_REGISTRY";
  sex?: "ALL" | "MALE" | "FEMALE";
  healthyVolunteers?: boolean;
  sponsorClass?:
    | "INDUSTRY"
    | "NIH"
    | "FED"
    | "OTHER"
    | "INDIV"
    | "NETWORK"
    | "OTHER_GOV"
    | "UNKNOWN";
  // Phase 2 filters
  allocation?: "RANDOMIZED" | "NON_RANDOMIZED" | "N_A";
  interventionModel?:
    | "SINGLE_GROUP"
    | "PARALLEL"
    | "CROSSOVER"
    | "FACTORIAL"
    | "SEQUENTIAL";
  primaryPurpose?:
    | "TREATMENT"
    | "PREVENTION"
    | "DIAGNOSTIC"
    | "SUPPORTIVE_CARE"
    | "SCREENING"
    | "HEALTH_SERVICES_RESEARCH"
    | "BASIC_SCIENCE"
    | "DEVICE_FEASIBILITY"
    | "OTHER";
  minAge?: string; // e.g., "18 Years", "65 Years"
  maxAge?: string;
  // Phase 3 filters
  ageGroups?: ("CHILD" | "ADULT" | "OLDER_ADULT")[]; // Array matching - study must include at least one
  masking?: "NONE" | "SINGLE" | "DOUBLE" | "TRIPLE" | "QUADRUPLE";
  fdaRegulated?: boolean; // Either drug OR device regulated
  keyword?: string; // Substring search in keywords array
}
