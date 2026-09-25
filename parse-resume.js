import fs from 'fs';
import path from 'path';
import { PDFParse } from 'pdf-parse';

export function findLatestResumePath(searchDir = process.cwd()) {
  const locations = new Set();

  if (searchDir && fs.existsSync(searchDir)) locations.add(searchDir);

  const candidates = [
    process.cwd(),
    path.join(process.env.USERPROFILE || '', 'Downloads'),
    path.join(process.env.USERPROFILE || '', 'Documents'),
    path.join(process.env.HOME || '', 'Downloads'),
    path.join(process.env.HOME || '', 'Documents')
  ];

  for (const item of candidates) {
    if (item && fs.existsSync(item)) locations.add(item);
  }

  const results = [];

  function isLikelyResumeFile(fileName) {
    const lower = fileName.toLowerCase();
    return /\.(pdf)$/i.test(fileName) && (
      lower.includes('resume') ||
      lower.includes('cv') ||
      lower.includes('shashank') ||
      lower.includes('profile') ||
      lower.includes('candidate')
    );
  }

  function traverse(currentPath) {
    if (!fs.existsSync(currentPath) || !fs.statSync(currentPath).isDirectory()) return;

    if (currentPath.toLowerCase().includes('appdata') || currentPath.toLowerCase().includes('searchext')) {
      return;
    }

    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        traverse(fullPath);
      } else if (isLikelyResumeFile(entry.name)) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > 0) {
            results.push({ filePath: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
          }
        } catch (error) {
          // Ignore unreadable files.
        }
      }
    }
  }

  for (const location of locations) {
    traverse(location);
  }

  if (results.length === 0) return null;
  results.sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    return b.mtimeMs - a.mtimeMs;
  });
  return results[0].filePath;
}

export async function parseResume(resumePath) {
  console.log(`\n=== Parsing Resume ===`);
  console.log(`Resume: ${resumePath}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    if (!resumePath || !fs.existsSync(resumePath)) {
      throw new Error(`Resume file does not exist: ${resumePath}`);
    }

    const dataBuffer = fs.readFileSync(resumePath);
    const parser = new PDFParse({ data: dataBuffer });
    const result = await parser.getText();

    console.log(`\n✓ PDF loaded successfully`);
    console.log(`Pages: ${result.total}`);
    console.log(`Text length: ${result.text.length} characters`);

    const text = result.text || '';
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    console.log(`\n✓ Extracted ${lines.length} lines of text`);

    const resumeData = {
      personal: {},
      contact: {},
      education: []
    };

    if (lines.length > 0) {
      const firstLine = lines[0];
      resumeData.personal.name = firstLine;
      const nameParts = firstLine.split(/\s+/).filter(Boolean);
      if (nameParts.length >= 2) {
        resumeData.personal.firstName = nameParts.slice(0, -1).join(' ');
        resumeData.personal.lastName = nameParts[nameParts.length - 1];
      }
      console.log(`Name: ${firstLine}`);
    }

    const emailMatch = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g);
    if (emailMatch && emailMatch.length > 0) {
      resumeData.contact.email = emailMatch[0];
      console.log(`Email: ${emailMatch[0]}`);
    }

    const phoneMatch = text.match(/(?<!\d)(?:\+?\d[\d\s().-]{7,}\d)(?!\d)/g);
    if (phoneMatch && phoneMatch.length > 0) {
      resumeData.contact.phone = phoneMatch[0].replace(/\s+/g, ' ').trim();
      console.log(`Phone: ${resumeData.contact.phone}`);
    }

    const educationHeading = /^(education|academic qualifications?|qualifications?|educational background)$/i;
    const otherHeading = /^(experience|work experience|employment|skills?|projects?|certifications?|achievements?|summary|profile|objective)$/i;
    let readingEducation = false;

    for (const line of lines) {
      if (educationHeading.test(line)) {
        readingEducation = true;
        continue;
      }

      if (otherHeading.test(line)) {
        readingEducation = false;
        continue;
      }

      if (readingEducation) {
        resumeData.education.push(line);
      }
    }

    console.log(`Education entries: ${resumeData.education.length}`);
    console.log('\n✓ Resume parsed successfully and prepared for applicant-scoped persistence.');

    return resumeData;
  } catch (error) {
    console.error(`\n❌ Error parsing resume: ${error.message}`);
    throw error;
  }
}

if (process.argv[1] && process.argv[1].endsWith('parse-resume.js')) {
  const resumePath = process.argv[2] || findLatestResumePath(process.cwd());
  if (!resumePath) {
    console.error('No resume PDF found. Please provide a path to a PDF.');
    process.exit(1);
  }

  parseResume(resumePath).catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
