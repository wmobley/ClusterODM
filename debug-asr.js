/**
 * Debug script to check ASR provider status
 */
const axios = require('axios');

const CLUSTERODM_URL = 'http://localhost:3000';
const TOKEN = 'eyJhbGciOiJSUzI1NiIsImtpZCI6Imd5YU5uVXJJZGxsYkhkWU5vWEpoRE85NTZDa0pkbWdybURPSDJNZHNnclkiLCJ0eXAiOiJKV1QifQ.eyJqdGkiOiJkZmRmZGY1Zi00NTk2LTQ0NGItYjkzYy1iNmZjZjI4YjM4ZjQiLCJpc3MiOiJodHRwczovL3BvcnRhbHMudGFwaXMuaW8vdjMvdG9rZW5zIiwic3ViIjoid21vYmxleUBwb3J0YWxzIiwidGFwaXMvdGVuYW50X2lkIjoicG9ydGFscyIsInRhcGlzL3Rva2VuX3R5cGUiOiJhY2Nlc3MiLCJ0YXBpcy9kZWxlZ2F0aW9uIjpmYWxzZSwidGFwaXMvZGVsZWdhdGlvbl9zdWIiOm51bGwsInRhcGlzL3VzZXJuYW1lIjoid21vYmxleSIsInRhcGlzL2FjY291bnRfdHlwZSI6InVzZXIiLCJleHAiOjE3NTY4MjkyMDAsInRhcGlzL2NsaWVudF9pZCI6bnVsbCwidGFwaXMvZ3JhbnRfdHlwZSI6InBhc3N3b3JkIn0.o63ilr5dxa3p1_D0lBERPxY0RITBywuByp1qORPjf3ET0Vc6ebLBVtS_XxPFyQecEPw4r_aIwrR0bxMnVhVQM6hs1qgedw0GSsXWsJj-x2CHHC2ZGMFSbPC20HocYaoKBmL7sIi15cNLApJH6_9MEkarx0cia-ZXGfhs7itpX6RCaMK3zW0WYSj8T8qxLsscakH5fmJmAoIAqjhzi-rReRBLp3lwyqXhZZUErzMG1SXbWyWN_Y1h02SCpLPqyg06y6RPEpmA4rlgINCiAxEuMLGFBi8xoNs_fzhT4OelSjYQgAB1ic_vsq6K48aQS9waZSqOoM2mgOMMK_ht8HuwgA';

async function debugClusterODM() {
    console.log('🔍 ClusterODM ASR Provider Debug');
    console.log('================================');
    
    try {
        // Check basic info
        console.log('1. Checking ClusterODM info...');
        const infoResponse = await axios.get(`${CLUSTERODM_URL}/info`);
        console.log('   ✅ ClusterODM is running');
        console.log('   📊 Info:', JSON.stringify(infoResponse.data, null, 2));
        
        // Try to trigger node creation by submitting a minimal task
        console.log('\n2. Attempting to trigger node creation...');
        try {
            const FormData = require('form-data');
            const fs = require('fs');
            
            const form = new FormData();
            // Add a test image
            if (fs.existsSync('./testData/DJI_20250801034350_0002_D.JPG')) {
                form.append('images', fs.createReadStream('./testData/DJI_20250801034350_0002_D.JPG'));
                
                console.log('   📤 Submitting test image...');
                const taskResponse = await axios.post(`${CLUSTERODM_URL}/task/new`, form, {
                    headers: {
                        ...form.getHeaders(),
                        'Authorization': `Bearer ${TOKEN}`
                    },
                    timeout: 30000
                });
                
                console.log('   ✅ Task submitted successfully!');
                console.log('   📋 Response:', JSON.stringify(taskResponse.data, null, 2));
            } else {
                console.log('   ⚠️  Test image not found, skipping task submission');
            }
        } catch (taskError) {
            console.log('   ❌ Task submission failed:');
            console.log('   📝 Error:', taskError.response?.data || taskError.message);
            
            // This might give us clues about ASR provider issues
            if (taskError.response?.data?.error) {
                console.log(`   🔍 Specific error: "${taskError.response.data.error}"`);
                
                if (taskError.response.data.error === "No nodes available") {
                    console.log('   💡 This suggests ASR provider is not working properly');
                    console.log('   🔧 Check that ClusterODM was started with:');
                    console.log('      node index.js --asr-provider tapis --asr-provider-options tapis-config.json');
                }
            }
        }
        
        // Check if we can access options after potential node creation
        console.log('\n3. Checking options (after potential node creation)...');
        try {
            const optionsResponse = await axios.get(`${CLUSTERODM_URL}/options`);
            console.log('   ✅ Options available:');
            console.log('   📋 Options:', JSON.stringify(optionsResponse.data, null, 2));
        } catch (optionsError) {
            console.log('   ❌ Options still not available:');
            console.log('   📝 Error:', optionsError.response?.data || optionsError.message);
        }
        
    } catch (error) {
        console.error('❌ Error connecting to ClusterODM:', error.message);
        console.error('💡 Make sure ClusterODM is running on localhost:3000');
    }
}

debugClusterODM();