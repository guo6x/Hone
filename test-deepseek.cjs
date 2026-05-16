const axios = require('axios');

async function testDeepSeek() {
    try {
        const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
            model: 'deepseek-chat',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 10
        }, {
            headers: {
                'Authorization': 'Bearer sk-66af77032f39453698eee1223099a19a',
                'Content-Type': 'application/json'
            }
        });
        console.log('Success:', response.data.choices[0].message.content);
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
    }
}

testDeepSeek();
