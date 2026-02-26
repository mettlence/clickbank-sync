// view_contact.js
const https = require('https');

// Configuration
const CONFIG = {
  accountName: 'mettlence', // e.g., 'yourcompany' from yourcompany.activehosted.com
  apiKey: '44b8fe196acd97ecac6c54ae3c8c15523a4f5bc75ac43a542e0a7e1582eda85ecaabbf59',
  limit: 10 // Number of contacts to fetch per request
};

const API_URL = `https://${CONFIG.accountName}.api-us1.com/api/3`;

// Function to make API request
function getContacts(offset = 0) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: `${CONFIG.accountName}.api-us1.com`,
      path: `/api/3/contacts?limit=${CONFIG.limit}&offset=${offset}`,
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
        try {
          const jsonData = JSON.parse(data);
          resolve(jsonData);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.end();
  });
}

// Main function
async function viewContacts() {
  try {
    console.log('Fetching contacts from ActiveCampaign...\n');
    
    const response = await getContacts(0);
    
    if (response.contacts && response.contacts.length > 0) {
      console.log(`Total contacts in account: ${response.meta.total}`);
      console.log(`Showing first ${response.contacts.length} contacts:\n`);
      
      response.contacts.forEach((contact, index) => {
        console.log(`${index + 1}. ID: ${contact.id}`);
        console.log(`   Email: ${contact.email}`);
        console.log(`   Name: ${contact.firstName} ${contact.lastName}`);
        console.log(`   Created: ${contact.cdate}`);
        console.log('---');
      });
    } else {
      console.log('No contacts found.');
    }
    
  } catch (error) {
    console.error('Error fetching contacts:', error.message);
  }
}

// Run the script
viewContacts();