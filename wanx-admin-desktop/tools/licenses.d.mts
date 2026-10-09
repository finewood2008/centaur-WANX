export interface LicenseNotice {
  name: string;
  version: string;
  license: string;
  licenseText: string;
}
export function collectLicenses(files: string[]): Promise<LicenseNotice[]>;
export function saveLicenses(
  output: string,
  files: string[],
): Promise<LicenseNotice[]>;
