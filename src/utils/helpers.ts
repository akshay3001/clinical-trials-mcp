import { Study, FilterParams } from "../models/types.js";
import { randomUUID } from "node:crypto";

const AGE_UNIT_DAYS = {
  year: 365.25,
  month: 365.25 / 12,
  week: 7,
  day: 1,
  hour: 1 / 24,
  minute: 1 / 1440,
} as const;

const AGE_PATTERN = new RegExp(
  `^(\\d+(?:\\.\\d+)?)\\s*(${Object.keys(AGE_UNIT_DAYS).join("|")})s?$`,
  "i",
);

/**
 * Converts a ClinicalTrials.gov age such as "18 Years" or "6 Months" to days,
 * so ages with different units compare correctly. Returns undefined for
 * values such as "N/A" that do not describe an age.
 */
export function parseAgeInDays(age: string): number | undefined {
  const match = AGE_PATTERN.exec(age.trim());
  if (!match) return undefined;
  const [, value, unit] = match;
  return (
    Number(value) *
    AGE_UNIT_DAYS[unit.toLowerCase() as keyof typeof AGE_UNIT_DAYS]
  );
}

function parseAgeFilter(name: string, age: string | undefined) {
  if (age === undefined) return undefined;
  const days = parseAgeInDays(age);
  if (days === undefined) {
    throw new RangeError(
      `${name} must be a number and unit, such as "18 Years" or "6 Months"`,
    );
  }
  return days;
}

const UPSTREAM_DATE_PATTERN = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/**
 * Converts a ClinicalTrials.gov date ("2020", "2020-03", or "2020-03-15") to
 * the first and last YYYY-MM-DD days it can describe. Returns undefined for
 * text in any other format.
 */
function parseDatePeriod(date: string) {
  const match = UPSTREAM_DATE_PATTERN.exec(date);
  if (!match) return undefined;
  const [, year, month, day] = match;
  if (day) return { first: date, last: date };
  if (month) {
    const lastDay = new Date(Date.UTC(Number(year), Number(month), 0));
    return { first: `${date}-01`, last: lastDay.toISOString().slice(0, 10) };
  }
  return { first: `${year}-01-01`, last: `${year}-12-31` };
}

/**
 * Checks a study date against inclusive YYYY-MM-DD bounds. When a bound is
 * set, missing or unparseable dates fail, and a partial date passes only if
 * its whole period is inside the bounds.
 */
function isWithinDateBounds(
  date: string | undefined,
  after: string | undefined,
  before: string | undefined,
): boolean {
  if (!after && !before) return true;
  const period = date ? parseDatePeriod(date) : undefined;
  if (!period) return false;
  if (after && period.first < after) return false;
  if (before && period.last > before) return false;
  return true;
}

/**
 * Converts a display label such as "Dietary Supplement" to the upstream enum
 * style "DIETARY_SUPPLEMENT". Enum values pass through unchanged.
 */
function toEnumValue(value: string): string {
  return value.trim().toUpperCase().replace(/ +/g, "_");
}

/**
 * Filter studies based on refinement criteria
 */
export function filterStudies(
  studies: Study[],
  filters: FilterParams,
): Study[] {
  const minAgeDays = parseAgeFilter("minAge", filters.minAge);
  const maxAgeDays = parseAgeFilter("maxAge", filters.maxAge);
  const patientAgeDays = parseAgeFilter("patientAge", filters.patientAge);

  return studies.filter((study) => {
    const protocol = study.protocolSection;

    const locations = protocol.contactsLocationsModule?.locations || [];
    const interventions = protocol.armsInterventionsModule?.interventions || [];
    const enrollment = protocol.designModule?.enrollmentInfo?.count;
    const startDate = protocol.statusModule?.startDateStruct?.date;

    // Location fields match exactly, ignoring case, and one site must match
    // every location field set in this call. Separate refine calls do not
    // share a site, because sessions do not keep earlier filters.
    const locationFilters = [
      ["country", filters.locationCountry],
      ["state", filters.locationState],
      ["city", filters.locationCity],
    ] as const;
    const activeLocationFilters = locationFilters.flatMap(([field, value]) =>
      value ? [{ field, value: value.trim().toLowerCase() }] : [],
    );
    if (activeLocationFilters.length > 0) {
      const hasSite = locations.some((loc) =>
        activeLocationFilters.every(
          ({ field, value }) => loc[field]?.trim().toLowerCase() === value,
        ),
      );
      if (!hasSite) return false;
    }

    // Enrollment bounds are inclusive. Studies without a count are excluded.
    if (filters.enrollmentMin !== undefined) {
      if (enrollment === undefined || enrollment < filters.enrollmentMin)
        return false;
    }

    if (filters.enrollmentMax !== undefined) {
      if (enrollment === undefined || enrollment > filters.enrollmentMax)
        return false;
    }

    if (
      !isWithinDateBounds(
        startDate,
        filters.startDateAfter,
        filters.startDateBefore,
      )
    )
      return false;

    // Filter by intervention type
    if (filters.interventionType) {
      const type = toEnumValue(filters.interventionType);
      const hasType = interventions.some(
        (int) => int.type !== undefined && toEnumValue(int.type) === type,
      );
      if (!hasType) return false;
    }

    // Filter by has results
    if (filters.hasResults !== undefined) {
      if (study.hasResults !== filters.hasResults) return false;
    }

    // Phase 1 filters

    // Filter by study type. Upstream has no PATIENT_REGISTRY study type:
    // registries are OBSERVATIONAL studies with patientRegistry set to true.
    if (filters.studyType === "PATIENT_REGISTRY") {
      if (protocol.designModule?.patientRegistry !== true) return false;
    } else if (filters.studyType) {
      const studyType = protocol.designModule?.studyType?.toUpperCase();
      if (studyType !== filters.studyType.toUpperCase()) return false;
    }

    // Filter by sex
    if (filters.sex) {
      const sex = protocol.eligibilityModule?.sex?.toUpperCase();
      if (sex !== filters.sex.toUpperCase()) return false;
    }

    // Filter by healthy volunteers
    if (filters.healthyVolunteers !== undefined) {
      const healthyVolunteers = protocol.eligibilityModule?.healthyVolunteers;
      if (healthyVolunteers !== filters.healthyVolunteers) return false;
    }

    // Filter by sponsor class
    if (filters.sponsorClass) {
      const sponsorClass =
        protocol.sponsorCollaboratorsModule?.leadSponsor?.class?.toUpperCase();
      if (sponsorClass !== filters.sponsorClass.toUpperCase()) return false;
    }

    // Phase 2 filters

    // Filter by allocation
    if (filters.allocation) {
      const allocation = protocol.designModule?.designInfo?.allocation;
      if (
        allocation === undefined ||
        toEnumValue(allocation) !== toEnumValue(filters.allocation)
      )
        return false;
    }

    // Filter by intervention model
    if (filters.interventionModel) {
      const model = protocol.designModule?.designInfo?.interventionModel;
      if (
        model === undefined ||
        toEnumValue(model) !== toEnumValue(filters.interventionModel)
      )
        return false;
    }

    // Filter by primary purpose
    if (filters.primaryPurpose) {
      const purpose = protocol.designModule?.designInfo?.primaryPurpose;
      if (
        purpose === undefined ||
        toEnumValue(purpose) !== toEnumValue(filters.primaryPurpose)
      )
        return false;
    }

    // Keep studies whose minimum eligible age is at least minAge (inclusive).
    // Studies without a parseable minimum age are excluded.
    if (minAgeDays !== undefined) {
      const studyMinDays = parseAgeInDays(
        protocol.eligibilityModule?.minimumAge ?? "",
      );
      if (studyMinDays === undefined || studyMinDays < minAgeDays) return false;
    }

    // Keep studies whose maximum eligible age is at most maxAge (inclusive).
    // Studies without a parseable maximum age are excluded.
    if (maxAgeDays !== undefined) {
      const studyMaxDays = parseAgeInDays(
        protocol.eligibilityModule?.maximumAge ?? "",
      );
      if (studyMaxDays === undefined || studyMaxDays > maxAgeDays) return false;
    }

    // Keep studies that a patient of this age can join (inclusive bounds).
    // A missing or unparseable study minimum or maximum means no limit.
    if (patientAgeDays !== undefined) {
      const eligibility = protocol.eligibilityModule;
      const studyMinDays = parseAgeInDays(eligibility?.minimumAge ?? "");
      const studyMaxDays = parseAgeInDays(eligibility?.maximumAge ?? "");
      if (studyMinDays !== undefined && patientAgeDays < studyMinDays)
        return false;
      if (studyMaxDays !== undefined && patientAgeDays > studyMaxDays)
        return false;
    }

    // Phase 3 filters

    // Filter by age groups (array matching - study must include at least one)
    if (filters.ageGroups && filters.ageGroups.length > 0) {
      const studyAgeGroups = protocol.eligibilityModule?.stdAges || [];
      const hasMatch = filters.ageGroups.some((ag) =>
        studyAgeGroups.some((sag) => sag.toUpperCase() === ag.toUpperCase()),
      );
      if (!hasMatch) return false;
    }

    // Filter by masking
    if (filters.masking) {
      const masking =
        protocol.designModule?.designInfo?.maskingInfo?.masking?.toUpperCase();
      if (masking !== filters.masking.toUpperCase()) return false;
    }

    // Filter by FDA regulated (drug OR device). Either flag true means
    // regulated; otherwise any flag false means not regulated. Studies with
    // both flags missing are unknown and excluded for both filter values.
    if (filters.fdaRegulated !== undefined) {
      const flags = [
        protocol.oversightModule?.isFdaRegulatedDrug,
        protocol.oversightModule?.isFdaRegulatedDevice,
      ];
      const isFDARegulated = flags.includes(true)
        ? true
        : flags.includes(false)
          ? false
          : undefined;
      if (isFDARegulated !== filters.fdaRegulated) return false;
    }

    // Filter by keyword (substring search in keywords array)
    if (filters.keyword) {
      const keywords = protocol.conditionsModule?.keywords || [];
      const hasKeyword = keywords.some((kw) =>
        kw.toLowerCase().includes(filters.keyword!.toLowerCase()),
      );
      if (!hasKeyword) return false;
    }

    return true;
  });
}

/**
 * Generate a session ID
 */
export function generateSessionId(): string {
  return randomUUID();
}

/**
 * Format study summary
 */
export function formatStudySummary(
  study: Study,
  includeEligibility: boolean = true,
): string {
  const protocol = study.protocolSection;
  const id = protocol.identificationModule;
  const status = protocol.statusModule;
  const description = protocol.descriptionModule;
  const conditions = protocol.conditionsModule;
  const design = protocol.designModule;
  const eligibility = protocol.eligibilityModule;
  const interventions = protocol.armsInterventionsModule;
  const locations = protocol.contactsLocationsModule;
  const sponsor = protocol.sponsorCollaboratorsModule;

  let summary = `## ${id.nctId}: ${id.briefTitle}\n\n`;

  if (id.officialTitle && id.officialTitle !== id.briefTitle) {
    summary += `**Official Title:** ${id.officialTitle}\n\n`;
  }

  if (id.acronym) {
    summary += `**Acronym:** ${id.acronym}\n\n`;
  }

  summary += `### Study Details\n\n`;
  summary += `- **Status:** ${status.overallStatus}\n`;
  summary += `- **Study Type:** ${design?.studyType || "N/A"}\n`;

  if (design?.phases && design.phases.length > 0) {
    summary += `- **Phase:** ${design.phases.join(", ")}\n`;
  }

  if (design?.enrollmentInfo?.count !== undefined) {
    summary += `- **Enrollment:** ${design.enrollmentInfo.count} participants`;
    if (design.enrollmentInfo.type) {
      summary += ` (${design.enrollmentInfo.type})`;
    }
    summary += "\n";
  }

  if (status.startDateStruct?.date) {
    summary += `- **Start Date:** ${status.startDateStruct.date}`;
    if (status.startDateStruct.type) {
      summary += ` (${status.startDateStruct.type})`;
    }
    summary += "\n";
  }

  if (status.primaryCompletionDateStruct?.date) {
    summary += `- **Primary Completion:** ${status.primaryCompletionDateStruct.date}`;
    if (status.primaryCompletionDateStruct.type) {
      summary += ` (${status.primaryCompletionDateStruct.type})`;
    }
    summary += "\n";
  }

  if (sponsor?.leadSponsor) {
    summary += `- **Sponsor:** ${sponsor.leadSponsor.name}`;
    if (sponsor.leadSponsor.class) {
      summary += ` (${sponsor.leadSponsor.class})`;
    }
    summary += "\n";
  }

  // Conditions
  if (conditions?.conditions && conditions.conditions.length > 0) {
    summary += `\n### Conditions\n\n`;
    summary += conditions.conditions.map((c) => `- ${c}`).join("\n") + "\n";
  }

  // Interventions
  const interventionItems = (interventions?.interventions ?? [])
    .map(({ type, name, description }) => {
      const label = [type && `**${type}:**`, name].filter(Boolean).join(" ");
      return [label, description].filter(Boolean).join("\n  ");
    })
    .filter(Boolean);
  if (interventionItems.length > 0) {
    summary += `\n### Interventions\n\n`;
    summary += interventionItems.map((item) => `- ${item}\n`).join("");
  }

  // Primary Outcomes
  const outcomes = protocol.outcomesModule;
  if (outcomes?.primaryOutcomes && outcomes.primaryOutcomes.length > 0) {
    summary += `\n### Primary Outcomes\n\n`;
    for (const outcome of outcomes.primaryOutcomes) {
      summary += `- **${outcome.measure}**`;
      if (outcome.timeFrame) {
        summary += ` (${outcome.timeFrame})`;
      }
      if (outcome.description) {
        summary += `\n  ${outcome.description}`;
      }
      summary += "\n";
    }
  }

  // Secondary Outcomes
  if (outcomes?.secondaryOutcomes && outcomes.secondaryOutcomes.length > 0) {
    summary += `\n### Secondary Outcomes\n\n`;
    for (const outcome of outcomes.secondaryOutcomes) {
      summary += `- **${outcome.measure}**`;
      if (outcome.timeFrame) {
        summary += ` (${outcome.timeFrame})`;
      }
      if (outcome.description) {
        summary += `\n  ${outcome.description}`;
      }
      summary += "\n";
    }
  }

  // Brief Summary
  if (description?.briefSummary) {
    summary += `\n### Summary\n\n${description.briefSummary}\n`;
  }

  // Detailed Description
  if (description?.detailedDescription) {
    summary += `\n### Detailed Description\n\n${description.detailedDescription}\n`;
  }

  // Eligibility Criteria
  if (includeEligibility && eligibility) {
    summary += `\n### Eligibility Criteria\n\n`;

    if (eligibility.eligibilityCriteria) {
      summary += `${eligibility.eligibilityCriteria}\n\n`;
    }

    summary += `**Key Requirements:**\n`;

    if (eligibility.sex) {
      summary += `- Sex: ${eligibility.sex}\n`;
    }

    if (eligibility.minimumAge || eligibility.maximumAge) {
      summary += `- Age: ${eligibility.minimumAge || "No minimum"} to ${eligibility.maximumAge || "No maximum"}\n`;
    }

    if (eligibility.healthyVolunteers !== undefined) {
      summary += `- Healthy Volunteers: ${eligibility.healthyVolunteers ? "Yes" : "No"}\n`;
    }
  }

  // Locations
  if (locations?.locations && locations.locations.length > 0) {
    summary += `\n### Locations (${locations.locations.length} sites)\n\n`;

    // Group by country
    const byCountry = new Map<string, typeof locations.locations>();
    for (const loc of locations.locations) {
      const country = loc.country || "Unknown";
      if (!byCountry.has(country)) {
        byCountry.set(country, []);
      }
      byCountry.get(country)!.push(loc);
    }

    for (const [country, locs] of byCountry) {
      summary += `**${country}** (${locs.length} sites)\n`;

      // Show first 5 locations per country
      const displayLocs = locs.slice(0, 5);
      for (const loc of displayLocs) {
        const parts = [loc.facility, loc.city, loc.state].filter(Boolean);
        summary += `- ${parts.join(", ")}`;
        if (loc.status) {
          summary += ` (${loc.status})`;
        }
        summary += "\n";
      }

      if (locs.length > 5) {
        summary += `  ... and ${locs.length - 5} more\n`;
      }
      summary += "\n";
    }
  }

  return summary;
}

/**
 * Format multiple studies as a list
 */
export function formatStudyList(
  studies: Study[],
  maxResults: number = 10,
): string {
  let output = `Found ${studies.length} studies\n\n`;

  const displayStudies = studies.slice(0, maxResults);

  for (let i = 0; i < displayStudies.length; i++) {
    const study = displayStudies[i];
    const protocol = study.protocolSection;
    const id = protocol.identificationModule;
    const status = protocol.statusModule;
    const design = protocol.designModule;

    output += `${i + 1}. **${id.nctId}** - ${id.briefTitle}\n`;
    output += `   Status: ${status.overallStatus}`;

    if (design?.phases && design.phases.length > 0) {
      output += ` | Phase: ${design.phases.join(", ")}`;
    }

    if (design?.enrollmentInfo?.count !== undefined) {
      output += ` | Enrollment: ${design.enrollmentInfo.count}`;
    }

    output += "\n\n";
  }

  if (studies.length > maxResults) {
    output += `... and ${studies.length - maxResults} more studies\n`;
  }

  return output;
}
