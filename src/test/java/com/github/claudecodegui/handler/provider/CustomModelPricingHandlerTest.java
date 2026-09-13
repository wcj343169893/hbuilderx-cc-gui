package com.github.claudecodegui.handler.provider;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.settings.ModelPricing;
import org.junit.Test;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class CustomModelPricingHandlerTest {

    @Test
    public void shouldPersistOnlyModelsWithValidPricing() {
        CapturingSettingsService settings = new CapturingSettingsService();
        CustomModelPricingHandler handler = new CustomModelPricingHandler(null, settings);

        boolean handled = handler.handle(CustomModelPricingHandler.SET_TYPE, """
                {
                  "provider": "codex",
                  "models": [
                    {
                      "id": "custom-codex",
                      "pricing": {
                        "inputCostPer1M": 0.2,
                        "outputCostPer1M": 0.8,
                        "cacheReadCostPer1M": 0.02
                      }
                    },
                    {
                      "id": "default-price-model"
                    },
                    {
                      "id": "partial-price-model",
                      "pricing": {
                        "inputCostPer1M": 0.3,
                        "outputCostPer1M": -1
                      }
                    }
                  ]
                }
                """);

        assertTrue(handled);
        assertEquals("codex", settings.providerRef.get());
        Map<String, ModelPricing> savedPricing = settings.pricingRef.get();
        assertEquals(2, savedPricing.size());
        assertEquals(0.2, savedPricing.get("custom-codex").inputCostPer1M(), 0.000001);
        assertEquals(0.8, savedPricing.get("custom-codex").outputCostPer1M(), 0.000001);
        assertEquals(0.02, savedPricing.get("custom-codex").cacheReadCostPer1M(), 0.000001);
        assertEquals(0.3, savedPricing.get("partial-price-model").inputCostPer1M(), 0.000001);
        assertNull(savedPricing.get("partial-price-model").outputCostPer1M());
    }

    @Test
    public void shouldIgnoreUnknownProvider() {
        CapturingSettingsService settings = new CapturingSettingsService();
        CustomModelPricingHandler handler = new CustomModelPricingHandler(null, settings);

        boolean handled = handler.handle(CustomModelPricingHandler.SET_TYPE, "{\"provider\":\"other\",\"models\":[]}");

        assertTrue(handled);
        assertNull(settings.providerRef.get());
        assertNull(settings.pricingRef.get());
    }

    private static final class CapturingSettingsService extends CodemossSettingsService {
        private final AtomicReference<String> providerRef = new AtomicReference<>();
        private final AtomicReference<Map<String, ModelPricing>> pricingRef = new AtomicReference<>();

        @Override
        public void setCustomModelPricing(String provider, Map<String, ModelPricing> pricing) throws IOException {
            providerRef.set(provider);
            pricingRef.set(pricing);
        }
    }
}
