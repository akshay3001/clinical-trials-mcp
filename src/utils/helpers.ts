import { Study, FilterParams } from "../models/types.js";

/**
 * Filter studies based on refinement criteria
 */
export function filterStudies(
  studies: Study[],
  filters: FilterParams,
): Study[] {
  return studies.filter((study) => {
    const protocol = study.protocolSection;

    // Phase filtering according to ClinicalTrials.gov API enum values:
    // NA (Not Applicable), EARLY_PHASE1 (Early Phase 1), PHASE1 (Phase 1),
    // PHASE2 (Phase 2), PHASE3 (Phase 3), PHASE4 (Phase 4)
    if (filters && (filters as any).phase) {
      const phaseFilter = (filters as any).phase;
      const phases = protocol.designModule?.phases || [];

      // Normalize phase filter to match API source values (case-insensitive)
      const normalizedFilter = phaseFilter.toLowerCase();

      // Check if study has the requested phase
      const hasMatchingPhase = phases.some((p: string) => {
        const normalizedPhase = p.toLowerCase();
        // Handle exact match or early phase variants
        if (normalizedFilter === "phase 1") {
          // Accept "Phase 1" or "Early Phase 1" for Phase 1 searches
          return (
            normalizedPhase === "phase 1" || normalizedPhase === "early phase 1"
          );
        }
        return normalizedPhase === normalizedFilter;
      });

      if (!hasMatchingPhase) return false;
    }
    const locations = protocol.contactsLocationsModule?.locations || [];
    const interventions = protocol.armsInterventionsModule?.interventions || [];
    const enrollment = protocol.designModule?.enrollmentInfo?.count;
    const startDate = protocol.statusModule?.startDateStruct?.date;
    const completionDate = protocol.statusModule?.completionDateStruct?.date;

    // Filter by location country
    if (filters.locationCountry) {
      const hasCountry = locations.some((loc) =>
        loc.country
          ?.toLowerCase()
          .includes(filters.locationCountry!.toLowerCase()),
      );
      if (!hasCountry) return false;
    }

    // Filter by location state
    if (filters.locationState) {
      const hasState = locations.some((loc) =>
        loc.state?.toLowerCase().includes(filters.locationState!.toLowerCase()),
      );
      if (!hasState) return false;
    }

    // Filter by location city
    if (filters.locationCity) {
      const hasCity = locations.some((loc) =>
        loc.city?.toLowerCase().includes(filters.locationCity!.toLowerCase()),
      );
      if (!hasCity) return false;
    }

    // Filter by enrollment
    if (filters.enrollmentMin !== undefined && enrollment !== undefined) {
      if (enrollment < filters.enrollmentMin) return false;
    }

    if (filters.enrollmentMax !== undefined && enrollment !== undefined) {
      if (enrollment > filters.enrollmentMax) return false;
    }

    // Filter by start date
    if (filters.startDateAfter && startDate) {
      if (startDate < filters.startDateAfter) return false;
    }

    if (filters.startDateBefore && startDate) {
      if (startDate > filters.startDateBefore) return false;
    }

    // Filter by completion date
    if (filters.completionDateAfter && completionDate) {
      if (completionDate < filters.completionDateAfter) return false;
    }

    if (filters.completionDateBefore && completionDate) {
      if (completionDate > filters.completionDateBefore) return false;
    }

    // Filter by intervention type
    if (filters.interventionType) {
      const hasType = interventions.some(
        (int) =>
          int.type?.toLowerCase() === filters.interventionType!.toLowerCase(),
      );
      if (!hasType) return false;
    }

    // Filter by has results
    if (filters.hasResults !== undefined) {
      if (study.hasResults !== filters.hasResults) return false;
    }

    // Phase 1 filters

    // Filter by study type
    if (filters.studyType) {
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
      const allocation = protocol.designModule?.designInfo?.allocation
        ?.toUpperCase()
        .replace(/ /g, "_");
      if (allocation !== filters.allocation.toUpperCase().replace(/ /g, "_"))
        return false;
    }

    // Filter by intervention model
    if (filters.interventionModel) {
      const model = protocol.designModule?.designInfo?.interventionModel
        ?.toUpperCase()
        .replace(/ /g, "_");
      if (model !== filters.interventionModel.toUpperCase().replace(/ /g, "_"))
        return false;
    }

    // Filter by primary purpose
    if (filters.primaryPurpose) {
      const purpose = protocol.designModule?.designInfo?.primaryPurpose
        ?.toUpperCase()
        .replace(/ /g, "_");
      if (purpose !== filters.primaryPurpose.toUpperCase().replace(/ /g, "_"))
        return false;
    }

    // Filter by minimum age
    if (filters.minAge) {
      const studyMinAge = protocol.eligibilityModule?.minimumAge;
      if (!studyMinAge || studyMinAge === "N/A") return false;
      // Simple string comparison (e.g., "18 Years" vs "21 Years")
      if (studyMinAge < filters.minAge) return false;
    }

    // Filter by maximum age
    if (filters.maxAge) {
      const studyMaxAge = protocol.eligibilityModule?.maximumAge;
      if (!studyMaxAge || studyMaxAge === "N/A") return false;
      // Simple string comparison
      if (studyMaxAge > filters.maxAge) return false;
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

    // Filter by FDA regulated (drug OR device)
    if (filters.fdaRegulated !== undefined) {
      const oversight = protocol.oversightModule;
      if (oversight) {
        const isFDARegulated =
          oversight.isFdaRegulatedDrug || oversight.isFdaRegulatedDevice;
        if (isFDARegulated !== filters.fdaRegulated) return false;
      } else {
        // If oversight module doesn't exist, we can't filter by this criteria
        // Skip studies without oversight data when filter is specified
        return false;
      }
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
  return `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
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

  if (design?.enrollmentInfo?.count) {
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
  if (interventions?.interventions && interventions.interventions.length > 0) {
    summary += `\n### Interventions\n\n`;
    for (const intervention of interventions.interventions) {
      summary += `- **${intervention.type}:** ${intervention.name}`;
      if (intervention.description) {
        summary += `\n  ${intervention.description}`;
      }
      summary += "\n";
    }
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

    if (design?.enrollmentInfo?.count) {
      output += ` | Enrollment: ${design.enrollmentInfo.count}`;
    }

    output += "\n\n";
  }

  if (studies.length > maxResults) {
    output += `... and ${studies.length - maxResults} more studies\n`;
  }

  return output;
}
