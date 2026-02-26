// delete_contacts.js
const https = require('https');
const fs = require('fs');

// Configuration
const CONFIG = {
  accountName: 'mettlence', // e.g., 'yourcompany' from yourcompany.activehosted.com
  apiKey: '44b8fe196acd97ecac6c54ae3c8c15523a4f5bc75ac43a542e0a7e1582eda85ecaabbf59',
  batchSize: 100, // Number of contacts to fetch per request
  requestDelay: 250, // Delay between requests in ms (4 requests per second = safe)
  maxRetries: 3, // Maximum retry attempts for failed requests
  retryDelay: 2000, // Delay before retrying failed requests (ms)
  logFile: 'deletion_log.txt' // Log file for tracking progress
};

// Progress tracking
let stats = {
  totalContacts: 0,
  fetched: 0,
  deleted: 0,
  failed: 0,
  errors: []
};

// Utility function to sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Utility function to log
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);
  fs.appendFileSync(CONFIG.logFile, logMessage + '\n');
}

// Function to make GET request
function getContacts(offset = 0) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: `${CONFIG.accountName}.api-us1.com`,
      path: `/api/3/contacts?limit=${CONFIG.batchSize}&offset=${offset}`,
      method: 'GET',
      headers: {
        'Api-Token': CONFIG.apiKey
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const jsonData = JSON.parse(data);
            resolve(jsonData);
          } catch (e) {
            reject(new Error(`Parse error: ${e.message}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

// Function to delete a contact with retry logic
async function deleteContact(contactId, retryCount = 0) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: `${CONFIG.accountName}.api-us1.com`,
      path: `/api/3/contacts/${contactId}`,
      method: 'DELETE',
      headers: {
        'Api-Token': CONFIG.apiKey
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', async () => {
        if (res.statusCode === 200 || res.statusCode === 204) {
          resolve({ success: true, contactId });
        } else if (res.statusCode === 429) {
          // Rate limit hit
          if (retryCount < CONFIG.maxRetries) {
            log(`Rate limit hit for contact ${contactId}, retrying (${retryCount + 1}/${CONFIG.maxRetries})...`);
            await sleep(CONFIG.retryDelay * (retryCount + 1)); // Exponential backoff
            try {
              const result = await deleteContact(contactId, retryCount + 1);
              resolve(result);
            } catch (error) {
              reject(error);
            }
          } else {
            reject(new Error(`Rate limit exceeded after ${CONFIG.maxRetries} retries`));
          }
        } else if (res.statusCode >= 500 && retryCount < CONFIG.maxRetries) {
          // Server error, retry
          log(`Server error for contact ${contactId}, retrying (${retryCount + 1}/${CONFIG.maxRetries})...`);
          await sleep(CONFIG.retryDelay);
          try {
            const result = await deleteContact(contactId, retryCount + 1);
            resolve(result);
          } catch (error) {
            reject(error);
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', async (error) => {
      if (retryCount < CONFIG.maxRetries) {
        log(`Network error for contact ${contactId}, retrying (${retryCount + 1}/${CONFIG.maxRetries})...`);
        await sleep(CONFIG.retryDelay);
        try {
          const result = await deleteContact(contactId, retryCount + 1);
          resolve(result);
        } catch (retryError) {
          reject(retryError);
        }
      } else {
        reject(error);
      }
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

// Function to display progress
function displayProgress() {
  const percentage = stats.totalContacts > 0 
    ? ((stats.deleted + stats.failed) / stats.totalContacts * 100).toFixed(2)
    : 0;
  
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Progress: ${percentage}%`);
  console.log(`Total Contacts: ${stats.totalContacts}`);
  console.log(`Deleted: ${stats.deleted}`);
  console.log(`Failed: ${stats.failed}`);
  console.log(`Remaining: ${stats.totalContacts - stats.deleted - stats.failed}`);
  console.log(`${'='.repeat(50)}\n`);
}

// Main deletion function
async function deleteAllContacts() {
  try {
    // Initialize log file
    fs.writeFileSync(CONFIG.logFile, `Deletion started at ${new Date().toISOString()}\n`);
    log('Starting contact deletion process...');
    
    // First, get total count
    log('Fetching total contact count...');
    const initialResponse = await getContacts(0);
    stats.totalContacts = initialResponse.meta.total;
    
    log(`Total contacts to delete: ${stats.totalContacts}`);
    
    if (stats.totalContacts === 0) {
      log('No contacts found. Exiting...');
      return;
    }

    // Confirm before proceeding
    console.log('\n⚠️  WARNING: This will delete ALL contacts from your ActiveCampaign account!');
    console.log(`Total contacts to be deleted: ${stats.totalContacts}`);
    console.log('\nPress Ctrl+C within 10 seconds to cancel...\n');
    
    await sleep(10000);
    
    log('Proceeding with deletion...');

    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      try {
        // Fetch batch of contacts
        log(`Fetching contacts (offset: ${offset})...`);
        const response = await getContacts(offset);
        
        if (!response.contacts || response.contacts.length === 0) {
          hasMore = false;
          break;
        }

        stats.fetched += response.contacts.length;
        log(`Fetched ${response.contacts.length} contacts. Processing deletion...`);

        // Delete each contact in the batch
        for (const contact of response.contacts) {
          try {
            await deleteContact(contact.id);
            stats.deleted++;
            
            // Log progress every 100 deletions
            if (stats.deleted % 100 === 0) {
              displayProgress();
            }
            
            // Rate limiting delay
            await sleep(CONFIG.requestDelay);
            
          } catch (error) {
            stats.failed++;
            const errorMsg = `Failed to delete contact ${contact.id} (${contact.email}): ${error.message}`;
            log(errorMsg);
            stats.errors.push({ contactId: contact.id, email: contact.email, error: error.message });
          }
        }

        // Always fetch from offset 0 since we're deleting contacts
        // The list shifts down as we delete
        offset = 0;
        
        // Check if there are more contacts
        const checkResponse = await getContacts(0);
        hasMore = checkResponse.contacts && checkResponse.contacts.length > 0;
        
      } catch (error) {
        log(`Error fetching batch at offset ${offset}: ${error.message}`);
        await sleep(CONFIG.retryDelay);
      }
    }

    // Final report
    displayProgress();
    log('Deletion process completed!');
    log(`Successfully deleted: ${stats.deleted}`);
    log(`Failed: ${stats.failed}`);
    
    if (stats.errors.length > 0) {
      log('\nFailed contact IDs:');
      stats.errors.forEach(err => {
        log(`  - ID: ${err.contactId}, Email: ${err.email}, Error: ${err.error}`);
      });
    }

    log(`\nFull log saved to: ${CONFIG.logFile}`);

  } catch (error) {
    log(`Fatal error: ${error.message}`);
    console.error('Fatal error:', error);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\nProcess interrupted by user.');
  displayProgress();
  log('Process interrupted by user');
  log(`Deleted: ${stats.deleted}, Failed: ${stats.failed}, Remaining: ${stats.totalContacts - stats.deleted - stats.failed}`);
  process.exit(0);
});

// Run the script
console.log('ActiveCampaign Contact Deletion Script');
console.log('======================================\n');

deleteAllContacts();