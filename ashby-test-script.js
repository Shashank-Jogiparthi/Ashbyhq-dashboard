/**
 * Ashbyhq Application Form Analysis Script
 * Use this script to analyze Ashbyhq job application forms
 * Run: node ashby-test-script.js <ashby-job-url>
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';

// Use stealth plugin
chromium.use(StealthPlugin());

async function analyzeAshbyForm(jobUrl) {
  console.log(`\n=== Analyzing Ashbyhq Form ===`);
  console.log(`URL: ${jobUrl}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);

  const browser = await chromium.launch({ 
    headless: false, // Set to true for production
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    console.log('\n--- Step 1: Navigate to Job Page ---');
    await page.goto(jobUrl, { waitUntil: 'networkidle', timeout: 30000 });
    console.log('✓ Page loaded successfully');

    // Wait for page to stabilize
    await page.waitForTimeout(2000);

    console.log('\n--- Step 2: Check for CAPTCHA ---');
    const captchaSelectors = [
      '[class*="captcha"]',
      '[class*="turnstile"]',
      '[class*="recaptcha"]',
      'iframe[src*="recaptcha"]',
      'iframe[src*="turnstile"]',
      '[data-sitekey]'
    ];

    let captchaFound = false;
    for (const selector of captchaSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          console.log(`⚠ CAPTCHA found: ${selector}`);
          captchaFound = true;
        }
      } catch (e) {
        // Selector not found, continue
      }
    }

    if (!captchaFound) {
      console.log('✓ No CAPTCHA detected');
    }

    console.log('\n--- Step 3: Find Application Form ---');
    
    // Look for apply button or form
    const applySelectors = [
      'button:has-text("Apply")',
      'a:has-text("Apply")',
      '[class*="apply"]',
      '[data-testid*="apply"]',
      'form[action*="application"]'
    ];

    let applyButton = null;
    for (const selector of applySelectors) {
      try {
        applyButton = await page.$(selector);
        if (applyButton) {
          console.log(`✓ Found apply element: ${selector}`);
          break;
        }
      } catch (e) {
        // Continue
      }
    }

    if (!applyButton) {
      console.log('⚠ No apply button found - checking if form is already visible');
      // Check if form is already on the page
      const formSelectors = ['form', '[class*="application"]', '[class*="form"]'];
      for (const selector of formSelectors) {
        try {
          const form = await page.$(selector);
          if (form) {
            console.log(`✓ Form already visible: ${selector}`);
            break;
          }
        } catch (e) {
          // Continue
        }
      }
    } else {
      console.log('\n--- Step 4: Click Apply Button ---');
      await applyButton.click();
      console.log('✓ Apply button clicked');
      await page.waitForTimeout(3000);
    }

    console.log('\n--- Step 5: Analyze Form Fields ---');
    
    const formData = {
      url: jobUrl,
      timestamp: new Date().toISOString(),
      fields: [],
      security: {},
      submission: {}
    };

    // Analyze all input fields
    const inputTypes = ['input', 'textarea', 'select'];
    const allFields = [];

    for (const type of inputTypes) {
      try {
        const elements = await page.$$(`${type}`);
        for (const element of elements) {
          try {
            const fieldInfo = await element.evaluate(el => {
              const info = {
                type: el.tagName.toLowerCase(),
                fieldType: el.type || el.getAttribute('type') || 'text',
                name: el.name || el.getAttribute('name') || '',
                id: el.id || el.getAttribute('id') || '',
                placeholder: el.placeholder || '',
                required: el.required || false,
                disabled: el.disabled || false,
                visible: el.offsetParent !== null,
                label: ''
              };

              // Try to find associated label
              if (el.id) {
                const label = document.querySelector(`label[for="${el.id}"]`);
                if (label) info.label = label.textContent.trim();
              }

              // Check for parent label
              if (!info.label) {
                const parentLabel = el.closest('label');
                if (parentLabel) info.label = parentLabel.textContent.trim();
              }

              return info;
            });

            if (fieldInfo.visible && fieldInfo.name) {
              allFields.push(fieldInfo);
            }
          } catch (e) {
            // Skip problematic elements
          }
        }
      } catch (e) {
        console.log(`Error analyzing ${type}: ${e.message}`);
      }
    }

    // Analyze file upload fields
    try {
      const fileInputs = await page.$$('input[type="file"]');
      for (const input of fileInputs) {
        const fileField = await input.evaluate(el => ({
          type: 'file',
          name: el.name || '',
          accept: el.accept || '',
          required: el.required || false,
          multiple: el.multiple || false
        }));
        if (fileField.name) {
          allFields.push(fileField);
        }
      }
    } catch (e) {
      console.log(`Error analyzing file inputs: ${e.message}`);
    }

    formData.fields = allFields;

    console.log(`\n✓ Found ${allFields.length} form fields`);
    
    // Group fields by type
    const fieldCounts = {};
    allFields.forEach(field => {
      const type = field.type || field.fieldType;
      fieldCounts[type] = (fieldCounts[type] || 0) + 1;
    });

    console.log('\nField Type Breakdown:');
    Object.entries(fieldCounts).forEach(([type, count]) => {
      console.log(`  ${type}: ${count}`);
    });

    console.log('\n--- Step 6: Check for Security Tokens ---');
    
    // Look for CSRF tokens
    const tokenSelectors = [
      'input[name*="csrf"]',
      'input[name*="token"]',
      'input[name*="nonce"]',
      '[data-csrf]'
    ];

    for (const selector of tokenSelectors) {
      try {
        const tokens = await page.$$(selector);
        if (tokens.length > 0) {
          console.log(`⚠ Security tokens found: ${selector} (${tokens.length} instances)`);
          formData.security.tokens = formData.security.tokens || [];
          formData.security.tokens.push({ selector, count: tokens.length });
        }
      } catch (e) {
        // Continue
      }
    }

    if (!formData.security.tokens) {
      console.log('✓ No obvious security tokens detected');
    }

    console.log('\n--- Step 7: Analyze Submission Method ---');
    
    // Look for form element
    try {
      const form = await page.$('form');
      if (form) {
        const formInfo = await form.evaluate(el => ({
          action: el.action || '',
          method: el.method || 'GET',
          enctype: el.enctype || ''
        }));
        formData.submission = formInfo;
        console.log('✓ Form element found');
        console.log(`  Action: ${formInfo.action}`);
        console.log(`  Method: ${formInfo.method}`);
        console.log(`  Encoding: ${formInfo.enctype}`);
      } else {
        console.log('⚠ No traditional form element - may use AJAX');
      }
    } catch (e) {
      console.log('Error analyzing form element');
    }

    console.log('\n--- Step 8: Check for Rate Limiting Indicators ---');
    
    // Look for rate limit messages
    const rateLimitSelectors = [
      '*:has-text("rate limit")',
      '*:has-text("too many")',
      '*:has-text("try again")',
      '*:has-text("blocked")'
    ];

    for (const selector of rateLimitSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          console.log(`⚠ Rate limit message found: ${selector}`);
          formData.security.rateLimitMessage = true;
        }
      } catch (e) {
        // Continue
      }
    }

    if (!formData.security.rateLimitMessage) {
      console.log('✓ No rate limit messages detected');
    }

    console.log('\n--- Step 9: Check for Fraud Detection Scripts ---');
    
    // Get all scripts
    try {
      const scripts = await page.$$eval('script', scripts => 
        scripts.map(script => script.src || script.textContent).filter(Boolean)
      );

      const fraudKeywords = ['fingerprint', 'device', 'bot', 'detect', 'fraud'];
      const suspiciousScripts = scripts.filter(script => 
        fraudKeywords.some(keyword => script.toLowerCase().includes(keyword))
      );

      if (suspiciousScripts.length > 0) {
        console.log(`⚠ ${suspiciousScripts.length} potentially suspicious scripts found`);
        formData.security.suspiciousScripts = suspiciousScripts.length;
      } else {
        console.log('✓ No obvious fraud detection scripts');
      }
    } catch (e) {
      console.log('Error analyzing scripts');
    }

    // Save results
    const resultsDir = path.join(process.cwd(), 'ashby-analysis-results');
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }

    const filename = `ashby-analysis-${Date.now()}.json`;
    const filepath = path.join(resultsDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(formData, null, 2));

    console.log(`\n✓ Analysis complete. Results saved to: ${filename}`);
    console.log(`\n--- Summary ---`);
    console.log(`Total Fields: ${allFields.length}`);
    console.log(`CAPTCHA: ${captchaFound ? 'YES' : 'NO'}`);
    console.log(`Security Tokens: ${formData.security.tokens ? 'YES' : 'NO'}`);
    console.log(`Form Element: ${formData.submission.action ? 'YES' : 'NO'}`);

  } catch (error) {
    console.error(`\n❌ Error during analysis: ${error.message}`);
    throw error;
  } finally {
    await browser.close();
  }
}

// Main execution
const url = process.argv[2] || 'https://jobs.ashbyhq.com/bubble/32a3ade2-1e62-4ad9-9ab8-32036d6f7b6b';

if (!url) {
  console.error('Usage: node ashby-test-script.js <ashby-job-url>');
  console.error('Example: node ashby-test-script.js https://jobs.ashbyhq.com/company-name/job-id');
  process.exit(1);
}

console.log(`Target URL: ${url}`);

analyzeAshbyForm(url).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});